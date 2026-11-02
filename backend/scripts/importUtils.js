const path = require('path');
const JSZip = require('jszip');
const { SaxesParser } = require('saxes');

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function readWorkbookRows(file, sheetName) {
  const fileBuffer = require('fs').readFileSync(path.resolve(file));
  if (fileBuffer.length > 30 * 1024 * 1024) throw new Error('Workbook must be 30 MB or smaller.');
  const archive = await JSZip.loadAsync(fileBuffer);
  const workbookXml = await readZipEntry(archive, 'xl/workbook.xml');
  const relationsXml = await readZipEntry(archive, 'xl/_rels/workbook.xml.rels');
  const relationships = new Map();
  parseXml(relationsXml, node => {
    if (node.name === 'Relationship') relationships.set(node.attributes.Id, node.attributes.Target);
  });
  const worksheets = [];
  parseXml(workbookXml, node => {
    if (node.name === 'sheet') worksheets.push({ name: node.attributes.name, id: node.attributes['r:id'] });
  });
  const worksheet = sheetName
    ? worksheets.find(candidate => candidate.name === sheetName)
    : worksheets[0];
  if (!worksheet) {
    throw new Error(sheetName
      ? `Workbook is missing the "${sheetName}" worksheet.`
      : 'Workbook does not contain a worksheet.');
  }
  const target = relationships.get(worksheet.id);
  if (!target) throw new Error('Workbook worksheet relationship is invalid.');
  const worksheetPath = target.startsWith('/')
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join('xl', target));
  const worksheetXml = await readZipEntry(archive, worksheetPath);
  const sharedIndexes = parseHeaderSharedStringIndexes(worksheetXml);
  const sharedStrings = archive.file('xl/sharedStrings.xml')
    ? parseSharedStrings(await readZipEntry(archive, 'xl/sharedStrings.xml'), sharedIndexes)
    : [];
  const rows = parseWorksheet(worksheetXml, sharedStrings);
  if (!rows.length) throw new Error('The worksheet is empty.');

  const headers = rows[0].values.map(normalizeHeader);
  if (!headers.some(Boolean)) throw new Error('The worksheet is missing a header row.');

  const records = [];
  for (const row of rows.slice(1)) {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row.values[index] || '';
    });
    if (Object.values(record).some(value => value !== '')) {
      records.push({ rowNumber: row.rowNumber, values: record });
    }
  }
  return records;
}

async function readZipEntry(archive, name) {
  const entry = archive.file(name);
  if (!entry) throw new Error(`Workbook is missing ${name}.`);
  const uncompressedSize = entry._data && entry._data.uncompressedSize;
  if (Number.isFinite(uncompressedSize) && uncompressedSize > 30 * 1024 * 1024) {
    throw new Error('A workbook sheet exceeds the 30 MB import limit.');
  }
  const value = await entry.async('string');
  if (value.length > 30 * 1024 * 1024) throw new Error('A workbook sheet exceeds the 30 MB import limit.');
  return value;
}

function parseXml(xml, onOpen, onText, onClose) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', onOpen);
  if (onText) parser.on('text', onText);
  if (onClose) parser.on('closetag', node => onClose(typeof node === 'string' ? node : node.name));
  parser.write(xml).close();
}

function parseSharedStrings(xml, includedIndexes = null) {
  const strings = [];
  let parts = null;
  let captureText = false;
  let text = '';
  let index = -1;
  parseXml(xml, node => {
    if (node.name === 'si') parts = [];
    if (node.name === 't' && parts) {
      captureText = true;
      text = '';
    }
  }, value => {
    if (captureText) text += value;
  }, name => {
    if (name === 't' && captureText && parts) {
      parts.push(text);
      captureText = false;
    } else if (name === 'si' && parts) {
      index += 1;
      if (!includedIndexes || includedIndexes.has(index)) strings[index] = parts.join('');
      parts = null;
    }
  });
  return strings;
}

function parseHeaderSharedStringIndexes(xml) {
  const indexes = new Set();
  let firstRow = true;
  let inHeaderRow = false;
  let cell = null;
  let capturedValue = '';
  let captureValue = false;
  parseXml(xml, node => {
    if (node.name === 'row') {
      inHeaderRow = firstRow;
      firstRow = false;
    } else if (node.name === 'c' && inHeaderRow) {
      cell = { shared: node.attributes.t === 's', value: '' };
    } else if (cell && node.name === 'v') {
      captureValue = true;
      capturedValue = '';
    }
  }, value => {
    if (captureValue) capturedValue += value;
  }, name => {
    if (cell && name === 'v' && captureValue) {
      cell.value = capturedValue;
      captureValue = false;
    } else if (name === 'c' && cell) {
      if (cell.shared && /^\d+$/.test(cell.value)) indexes.add(Number(cell.value));
      cell = null;
    } else if (name === 'row') {
      inHeaderRow = false;
    }
  });
  return indexes;
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i);
  if (!letters) throw new Error('Workbook contains an invalid cell reference.');
  let index = 0;
  for (const letter of letters[0].toUpperCase()) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const sensitiveColumns = new Set();
  let row = null;
  let cell = null;
  let capturedTag = '';
  let capturedValue = '';
  let nextRowNumber = 0;
  let headerRowNumber = null;
  parseXml(xml, node => {
    if (node.name === 'row') {
      nextRowNumber += 1;
      row = { rowNumber: Number(node.attributes.r) || nextRowNumber, values: [] };
      if (headerRowNumber === null) headerRowNumber = row.rowNumber;
    } else if (node.name === 'c' && row) {
      const index = columnIndex(node.attributes.r);
      cell = {
        index,
        type: node.attributes.t || '',
        value: '',
        skip: row.rowNumber !== headerRowNumber && sensitiveColumns.has(index)
      };
    } else if (cell && !cell.skip && (node.name === 'v' || node.name === 't')) {
      capturedTag = node.name;
      capturedValue = '';
    }
  }, value => {
    if (capturedTag) capturedValue += value;
  }, name => {
    if (cell && name === capturedTag) {
      cell.value += capturedValue;
      capturedTag = '';
    } else if (name === 'c' && cell && row) {
      const value = cell.type === 's' ? sharedStrings[Number(cell.value)] : cell.value;
      if (!cell.skip) row.values[cell.index] = String(value || '').trim();
      cell = null;
    } else if (name === 'row' && row) {
      if (row.rowNumber === headerRowNumber) {
        row.values.forEach((header, index) => {
          if (/(password|passcode|secret|credential)/i.test(String(header || ''))) sensitiveColumns.add(index);
        });
      }
      rows.push(row);
      row = null;
    }
  });
  return rows;
}

function firstValue(record, aliases) {
  for (const alias of aliases) {
    const value = record[alias];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validBcryptHash(value) {
  return /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(String(value || ''));
}

async function applyInitialPassword(account, password, bcrypt) {
  const hasValidHash = validBcryptHash(account.password_hash);
  if (hasValidHash && Number(account.must_change_password) === 0) return null;
  if (hasValidHash && await bcrypt.compare(password, account.password_hash)) return null;
  return bcrypt.hash(password, 12);
}

module.exports = {
  applyInitialPassword,
  firstValue,
  normalizeHeader,
  parseSharedStrings,
  parseHeaderSharedStringIndexes,
  parseWorksheet,
  parseXml,
  readWorkbookRows,
  validBcryptHash,
  validEmail
};

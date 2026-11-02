let certificateImage = null;
let certificateImageKey = '';

function certificateAssetFor(result) {
  const title = String(result?.assessmentTitle || '').toLowerCase();
  if (title.includes('office management tool')) {
    return '/assets/office-management-certificate.png';
  }
  return '/assets/zero-technologies-certificate.png';
}

function loadCertificateImage(result) {
  const src = certificateAssetFor(result);
  if (certificateImage && certificateImageKey === src) return Promise.resolve(certificateImage);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      certificateImage = img;
      certificateImageKey = src;
      resolve(img);
    };
    img.onerror = () => reject(new Error('Certificate background could not be loaded.'));
    img.src = src;
  });
}

async function drawCertificate(r) {
  const canvas = document.getElementById('certificateCanvas');
  const ctx = canvas.getContext('2d');
  try {
    const img = await loadCertificateImage(r);
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);

    const isOffice = String(r.assessmentTitle || '').toLowerCase().includes('office management tool');
    const sx = canvas.width / 1536;
    const sy = canvas.height / 1087;
    ctx.fillStyle = '#0b2345';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    function fitted(text, x, y, maxWidth, size, min = 18) {
      let s = size;
      ctx.font = `600 ${s}px Arial, sans-serif`;
      while (ctx.measureText(String(text)).width > maxWidth && s > min) {
        s -= 1;
        ctx.font = `600 ${s}px Arial, sans-serif`;
      }
      ctx.fillText(String(text), x * sx, y * sy);
    }

    // Candidate name, score, date and ID are drawn on top of the selected subject's template.
    fitted(r.candidateName || '', 768, isOffice ? 435 : 425, 1080, 52, 24);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isOffice) {
      // Office template has centered headings and three fixed underline fields.
      // Keep values centered inside their own columns, below each heading and above its line.
      const valueY = 748;
      ctx.font = '600 22px Arial, sans-serif';
      ctx.fillText(`${r.percentage}% (${r.correctAnswers}/${r.totalQuestions})`, 291 * sx, valueY * sy, 285 * sx);
      ctx.fillText(new Date(r.completedAt).toLocaleDateString('en-GB'), 715 * sx, valueY * sy, 280 * sx);
      ctx.font = '600 17px Arial, sans-serif';
      ctx.fillText(String(r.certificateId || ''), 1145 * sx, valueY * sy, 285 * sx);
    } else {
      const scoreY = 782;
      ctx.font = '600 22px Arial, sans-serif';
      ctx.fillText(`${r.percentage}% (${r.correctAnswers}/${r.totalQuestions})`, 335 * sx, scoreY * sy);
      ctx.fillText(new Date(r.completedAt).toLocaleDateString('en-GB'), 750 * sx, scoreY * sy);
      ctx.font = '600 18px Arial, sans-serif';
      ctx.fillText(String(r.certificateId || ''), 1265 * sx, scoreY * sy);
    }
    return canvas;
  } catch (e) {
    document.getElementById('certificateArea').classList.add('hidden');
    throw e;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('downloadCertificate');
  if (!button) return;
  button.disabled = true;
  button.addEventListener('click', () => {
    const canvas = document.getElementById('certificateCanvas');
    canvas.toBlob(blob => {
      if (!blob) {
        alert('PNG export failed.');
        return;
      }
      const title = String(window.__lastCertificateTitle || 'Certificate');
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ZERO-TECHNOLOGIES-${slug || 'certificate'}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  });
  // Preload the default Web Design certificate; the correct subject template is selected when results render.
  loadCertificateImage({ assessmentTitle: 'Introduction to Web Design' }).catch(() => { button.disabled = true; });
});

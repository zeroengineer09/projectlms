require('dotenv').config();
const bcrypt=require('bcryptjs');
const {get,run}=require('./database'); const {ensureSchema}=require('./migrations');
const teachers=[
['Archana M. Jade','archana.jade@rcpimrd.ac.in'],
['Diksha Vikas Patil','dikshapatil41103@gmail.com'],
['Dr. Laxmikant M. Sharma','sharmalaxmikant07@gmail.com'],
['Kirtika N. Behere','kirtikabehere20@gmail.com'],
['Lucky Rajendra Kalal','luckykalal9@gmail.com'],
['Milind A. Patil','patilmilind732@gmail.com'],
['Priyanka S. Saindane','piyurap1418@gmail.com'],
['Rahul D. Chaudhari','rdc.imrd@gmail.com'],
['Vaishnavi Nandalal Kuwar','vaishnavikuwar215@gmail.com'],
['Dr. Tushar R. Patel','tushar.patel@rcpimrd.ac.in']
];
async function main(){
 await ensureSchema();
 const tp=process.env.TEACHER_INITIAL_PASSWORD,op=process.env.OWNER_INITIAL_PASSWORD;
 if(!tp||!op)throw new Error('Set TEACHER_INITIAL_PASSWORD and OWNER_INITIAL_PASSWORD before initializing accounts.');
 for(const [name,email] of teachers){const old=await get('SELECT id FROM teachers WHERE lower(email)=lower(?)',[email]);const hash=await bcrypt.hash(tp,12);if(!old)await run('INSERT INTO teachers(full_name,email,password_hash,must_change_password) VALUES(?,?,?,1)',[name,email,hash]);else await run("UPDATE teachers SET full_name=?,password_hash=?,must_change_password=1,password_changed_at=NULL,active=1 WHERE id=?",[name,hash,old.id]);}
 const email='kaushalpatil927@gmail.com';let owner=await get('SELECT * FROM administrators WHERE lower(username)=lower(?)',[email]);const hash=await bcrypt.hash(op,12);if(!owner)await run('INSERT INTO administrators(username,password_hash,must_change_password) VALUES(?,?,1)',[email,hash]);
 console.log(`Initialized teacher accounts and owner account ${email}. Teacher passwords were set to the configured initial password and must be changed at first login. Existing owner password was preserved.`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});

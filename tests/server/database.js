const fs=require('fs'); const path=require('path'); const sqlite3=require('sqlite3').verbose();
const file=path.resolve(process.env.DATABASE_FILE||'./database/certified-developer-test.db'); fs.mkdirSync(path.dirname(file),{recursive:true});
const db=new sqlite3.Database(file); db.serialize(()=>db.run('PRAGMA foreign_keys=ON')); 
function run(sql,params=[]){return new Promise((resolve,reject)=>db.run(sql,params,function(e){e?reject(e):resolve({lastID:this.lastID,changes:this.changes})}))}
function get(sql,params=[]){return new Promise((resolve,reject)=>db.get(sql,params,(e,row)=>e?reject(e):resolve(row)))}
function all(sql,params=[]){return new Promise((resolve,reject)=>db.all(sql,params,(e,rows)=>e?reject(e):resolve(rows)))}
function exec(sql){return new Promise((resolve,reject)=>db.exec(sql,e=>e?reject(e):resolve()))}
module.exports={db,run,get,all,exec,file};

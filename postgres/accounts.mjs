import {randomBytes} from 'node:crypto';
import {passwordHash,passwordValid,digest,equal,publicUser} from '../auth.mjs';
import {fail,text,password,email,keys} from './validation.mjs';

export async function createPostgresAccounts(db,{now=Date.now}={}){
  const attempts=new Map(),dummyHash=await passwordHash(randomBytes(32).toString('hex'));
  const rowUser=row=>({...publicUser(row),created_at:row.created_at});
  async function activeActor(tx,actor){
    const user=await tx.get('SELECT * FROM users WHERE id=$1 AND active=1 FOR SHARE',[actor?.id||'']);
    if(!user)throw fail(401,'unauthorized','Faça login para continuar.');return user;
  }
  const admin=user=>{if(user.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');};
  async function login(input,{ip='',previousToken=''}={}){
    keys(input,['email','password']);const mail=email(input.email);text(input.password,'senha',256);const time=now();
    for(const [key,entry] of attempts)if(entry.expires<=time)attempts.delete(key);
    const rateKeys=['user:'+mail,'ip:'+ip];
    for(const key of rateKeys)if(attempts.get(key)?.count>=20)throw Object.assign(fail(429,'rate_limited','Muitas tentativas. Aguarde 15 minutos.'),{retryAfter:900});
    if(attempts.size>10000)throw fail(429,'rate_limited','Aguarde para tentar novamente.');
    for(const key of rateKeys){const entry=attempts.get(key)||{count:0,expires:time+900000};entry.count++;attempts.set(key,entry);}
    const observed=await db.get('SELECT * FROM users WHERE email=$1',[mail]);
    const valid=await passwordValid(input.password,observed?.password_hash||dummyHash);
    if(!observed||!valid||!observed.active)throw fail(401,'invalid_credentials','E-mail ou senha inválidos.');
    const result=await db.transaction(async tx=>{
      // Password verification yields to the event loop. Re-check under lock before issuing a session.
      const current=await tx.get('SELECT * FROM users WHERE id=$1 FOR UPDATE',[observed.id]);
      if(!current?.active||current.email!==mail||!equal(current.password_hash,observed.password_hash))throw fail(401,'invalid_credentials','E-mail ou senha inválidos.');
      const token=randomBytes(32).toString('hex'),issuedAt=now();
      await tx.run('DELETE FROM sessions WHERE expires_at<$1 OR id=$2',[issuedAt,digest(previousToken)]);
      await tx.run('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[digest(token),current.id,issuedAt+43200000]);
      return {user:publicUser(current),token,maxAge:43200};
    });
    attempts.delete('user:'+mail);const ipEntry=attempts.get(rateKeys[1]);if(ipEntry)ipEntry.count--;
    return result;
  }
  async function current(token){
    if(typeof token!=='string'||!token)return null;
    return await db.get('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND s.expires_at>$2 AND u.active=1',[digest(token),now()])||null;
  }
  const logout=token=>db.run('DELETE FROM sessions WHERE id=$1',[digest(token||'')]);
  async function list(actor){
    return db.transaction(async tx=>{
      const user=await tx.get('SELECT * FROM users WHERE id=$1 AND active=1',[actor?.id||'']);if(!user)throw fail(401,'unauthorized','Faça login para continuar.');admin(user);
      return (await tx.all('SELECT * FROM users ORDER BY created_at,id')).map(rowUser);
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  async function create(actor,input){
    keys(input,['name','email','password','role']);const role=input.role??'user';if(!['user','admin'].includes(role))throw fail(400,'invalid_role','Perfil inválido.');
    const name=text(input.name,'nome',120).trim(),mail=email(input.email),hash=await passwordHash(password(input.password)),id=randomBytes(12).toString('hex');
    try{return await db.transaction(async tx=>{
      admin(await activeActor(tx,actor));
      const row=await tx.get('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,name,mail,hash,role,new Date(now()).toISOString()]);return publicUser(row);
    });}catch(error){if(error.code==='23505')throw fail(409,'email_exists','E-mail já cadastrado.');throw error;}
  }
  async function update(actor,targetId,input){
    keys(input,['name','email','password','active','role']);
    const name=input.name===undefined?undefined:text(input.name,'nome',120).trim(),mail=input.email===undefined?undefined:email(input.email),hash=input.password===undefined?undefined:await passwordHash(password(input.password));
    if(input.active!==undefined&&typeof input.active!=='boolean')throw fail(400,'invalid_field','Status inválido.');
    if(input.role!==undefined&&!['user','admin'].includes(input.role))throw fail(400,'invalid_role','Perfil inválido.');
    try{return await db.transaction(async tx=>{
      // Deterministic locking avoids two admins editing one another in opposite lock order.
      const locked=await tx.all('SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[actor?.id||'',targetId]]);
      const executor=locked.find(r=>r.id===actor?.id),target=locked.find(r=>r.id===targetId);
      if(!executor?.active)throw fail(401,'unauthorized','Faça login para continuar.');admin(executor);
      if(!target)throw fail(404,'not_found','Usuário não encontrado.');
      if(target.is_master&&executor.id!==target.id)throw fail(403,'master_protected','Somente o próprio Admin Master pode editar sua conta.');
      const role=input.role??target.role,active=input.active===undefined?target.active:Number(input.active);
      if(target.is_master&&(!active||role!=='admin'))throw fail(400,'master_protected','O acesso do Admin Master não pode ser bloqueado.');
      const nextMail=mail??target.email;
      const row=await tx.get('UPDATE users SET name=$1,email=$2,password_hash=$3,active=$4,role=$5 WHERE id=$6 RETURNING *',[name??target.name,nextMail,hash??target.password_hash,active,role,targetId]);
      if(!active||hash!==undefined||nextMail!==target.email||role!==target.role)await tx.run('DELETE FROM sessions WHERE user_id=$1',[targetId]);
      const resumeInstanceIds=active?(await tx.all('SELECT id FROM instances WHERE owner_id=$1 AND active=1',[targetId])).map(r=>r.id):[];
      return {user:publicUser(row),resumeInstanceIds};
    });}catch(error){if(error.code==='23505')throw fail(409,'email_exists','E-mail já cadastrado.');throw error;}
  }
  return {login,current,logout,list,create,update};
}

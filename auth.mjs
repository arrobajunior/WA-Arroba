import { scrypt as rawScrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(rawScrypt);
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
export async function passwordHash(password){const salt=randomBytes(16).toString('hex');const result=await scrypt(password,salt,64);return `${salt}:${result.toString('hex')}`;}
export async function passwordValid(password,hash){const [salt,expected]=hash.split(':');const result=await scrypt(password,salt,64);return equal(result.toString('hex'),expected);}
export function sessionToken(req){const cookie=req.headers.cookie||'';return cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('wa_session='))?.slice(11)||'';}
export const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,active:Boolean(u.active)});

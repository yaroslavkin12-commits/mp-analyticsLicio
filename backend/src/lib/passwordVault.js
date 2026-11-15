const crypto=require('crypto');
function configured(){return /^[a-f\d]{64}$/i.test(process.env.USER_PASSWORD_VAULT_KEY||'');}
function key(){if(!configured())throw Object.assign(Error('Показ паролей доступен на основном сервере сервиса'),{status:503});return Buffer.from(process.env.USER_PASSWORD_VAULT_KEY,'hex');}
function seal(password,login){
 if(!configured())return null;
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from('defly-password:'+login));
 const encrypted=Buffer.concat([cipher.update(String(password),'utf8'),cipher.final()]);
 return ['v1',iv.toString('hex'),cipher.getAuthTag().toString('hex'),encrypted.toString('base64')].join(':');
}
function open(value,login){
 if(!value)return null;
 const master=key();
 try{const [version,iv,tag,data]=value.split(':');if(version!=='v1')throw Error();const cipher=crypto.createDecipheriv('aes-256-gcm',master,Buffer.from(iv,'hex'));cipher.setAAD(Buffer.from('defly-password:'+login));cipher.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');}
 catch{throw Object.assign(Error('Сохранённый пароль недоступен. Задайте пользователю новый пароль'),{status:409});}
}
module.exports={configured,seal,open};

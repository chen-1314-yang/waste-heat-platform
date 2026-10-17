import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'runtime-manifest.json'),'utf8'));
for(const [rel,hash] of Object.entries(manifest.files)) {
  if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex')!==hash)throw new Error('Checksum mismatch: '+rel);
}
function scan(dir) {
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    if(ent.name==='.git')continue;
    if(/^\.env|^\.user_api_key$|credentials|deploy_token/i.test(ent.name))throw new Error('Credential file is forbidden: '+ent.name);
    const full=path.join(dir,ent.name);
    if(ent.isDirectory())scan(full);
    else if(/sk-[a-zA-Z0-9]{24,}/.test(fs.readFileSync(full,'utf8')))throw new Error('Possible credential found: '+path.relative(root,full));
  }
}
scan(root);
console.log('Package verified: '+Object.keys(manifest.files).length+' frozen files; no credential files/keys.');

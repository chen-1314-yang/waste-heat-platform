import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(here,'runtime-manifest.json'),'utf8'));
for(const [file,expected] of Object.entries(manifest.files)) {
  const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(here,file))).digest('hex');
  if(actual!==expected)throw new Error('Frozen runtime checksum mismatch: '+file);
}
const {createCloudServer}=await import('./cloud-server.mjs');
const server=createCloudServer();
server.listen(Number(process.env.PORT||3211),process.env.HOST||'0.0.0.0',()=>console.log('Waste heat Agent service ready; runtime checksums verified.'));
process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();});

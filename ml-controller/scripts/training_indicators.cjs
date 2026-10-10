// Reuse the production Worker owner; never maintain a second formula.
const fs = require('node:fs');
const readline = require('node:readline');
const crypto = require('node:crypto');
const modulePath = process.env.TRAINING_INDICATOR_MODULE || require('node:path').resolve(__dirname, '../worker-dist/src/lib/technicalIndicators.js');
const {computeTechnicalIndicators} = require(modulePath);
async function main() {
 const output = fs.createWriteStream(process.argv[3]);
 for await (const line of readline.createInterface({input:fs.createReadStream(process.argv[2]),crlfDelay:Infinity})) {
  const {stock_id, prices} = JSON.parse(line);
  const indicators=[];
  for(let end=19;end<prices.length;end++) {
   const bars=prices.slice(Math.max(0,end-69),end+1);
   const raw=computeTechnicalIndicators(bars.map(p=>p.close),bars.map(p=>p.high??p.close),bars.map(p=>p.low??p.close),bars.map(p=>p.volume??0));
   indicators.push({date:prices[end].date,...raw});
  }
  if(!output.write(JSON.stringify({stock_id,indicators})+'\n')) await require('node:events').once(output,'drain');
 }
 output.end();await require('node:events').once(output,'finish');
 console.log(JSON.stringify({formula_sha256:crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex')}));
}
if(process.argv[2]==='--check') {
 if(typeof computeTechnicalIndicators!=='function') throw new Error('training_indicator_owner_export_missing');
 console.log('TRAINING_INDICATOR_OWNER_READY');
} else main().catch(e=>{console.error(e);process.exitCode=1});

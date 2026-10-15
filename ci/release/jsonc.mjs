// JSONC (wrangler.jsonc) to strict JSON: removes // and /* */ comments and trailing
// commas outside string literals, then parses with duplicate-key rejection.
import {parseJson} from '../../src/shared/release-contract.mjs';

function scanString(text,i){
 let j=i+1;
 while(j<text.length){
  const c=text[j];
  if(c==='\\'){j+=2;continue;}
  if(c==='"')return j+1;
  if(c==='\n')break;
  j++;
 }
 throw Error('JSONC: unterminated string');
}

export function stripJsonc(text){
 if(typeof text!=='string')throw Error('JSONC: expected text');
 let out='',i=0;
 while(i<text.length){
  const c=text[i],next=text[i+1];
  if(c==='"'){const end=scanString(text,i);out+=text.slice(i,end);i=end;}
  else if(c==='/'&&next==='/'){while(i<text.length&&text[i]!=='\n')i++;}
  else if(c==='/'&&next==='*'){
   const end=text.indexOf('*/',i+2);
   if(end<0)throw Error('JSONC: unterminated block comment');
   out+=text.slice(i,end+2).replace(/[^\n]/g,' ');i=end+2;
  }else{out+=c;i++;}
 }
 let result='';i=0;
 while(i<out.length){
  const c=out[i];
  if(c==='"'){const end=scanString(out,i);result+=out.slice(i,end);i=end;continue;}
  if(c===','){let j=i+1;while(j<out.length&&/\s/.test(out[j]))j++;if(out[j]==='}'||out[j]===']'){result+=' ';i++;continue;}}
  result+=c;i++;
 }
 return result;
}
export const parseJsonc=(bytes,{maxBytes,label='JSONC'}={})=>{
 let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error(`${label}: invalid UTF-8`);}
 return parseJson(stripJsonc(text),{maxBytes,label});
};

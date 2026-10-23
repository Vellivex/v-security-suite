// SPDX-License-Identifier: GPL-3.0-or-later
import {qrcodegen} from './vendor/qrcodegen.js';
import jsQR from './vendor/jsqr.js';
import {b64,un64,inspectTransfer,MAX_TRANSFER} from './protocol.js';
const E=new TextEncoder(),D=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',E.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export async function framesFor(text){await inspectTransfer(text);const bytes=E.encode(text);if(bytes.length>MAX_TRANSFER)throw Error('Transfer is too large.');const encoded=b64(bytes),digest=await hash(text),count=Math.ceil(encoded.length/360);if(count>96)throw Error('Too many QR frames.');return Array.from({length:count},(_,i)=>`VCQR1|${digest}|${count}|${i}|${encoded.slice(i*360,(i+1)*360)}`);}
export class Collector {
 constructor(){this.reset();}
 reset(){this.epoch=(this.epoch||0)+1;this.id=null;this.count=0;this.parts=new Map();this.started=0;}
 async add(frame,now=Date.now()){
  if(typeof frame!=='string'||frame.length>470)throw Error('Not a bounded V Cipher QR frame.');
  const m=/^VCQR1\|([0-9a-f]{64})\|([1-9][0-9]?)\|(0|[1-9][0-9]?)\|([A-Za-z0-9+/=]{1,360})$/.exec(frame);if(!m)throw Error('Not a V Cipher QR frame.');
  const [,id,c,i,part]=m,count=Number(c),index=Number(i);if(count>96||index>=count||index<count-1&&part.length!==360)throw Error('Invalid QR sequence.');
  if(this.id&&now-this.started>300000){this.reset();throw Error('QR collection expired. Start again.');}
  if(this.id&&(this.id!==id||this.count!==count))throw Error('A different QR transfer is in progress. Clear it first.');
  if(!this.id){this.id=id;this.count=count;this.started=now;}
  if(this.parts.has(index)&&this.parts.get(index)!==part)throw Error('Conflicting QR frame.');this.parts.set(index,part);
  if(this.parts.size<count)return {received:this.parts.size,total:count};
  const epoch=this.epoch;
  const text=D.decode(un64(Array.from({length:count},(_,n)=>this.parts.get(n)).join(''),1,MAX_TRANSFER));const digest=await hash(text);if(this.epoch!==epoch)throw Error('QR collection was cleared while verification was pending.');if(digest!==id)throw Error('QR transfer checksum failed. Clear and scan again.');await inspectTransfer(text);if(this.epoch!==epoch)throw Error('QR collection was cleared while verification was pending.');return {received:count,total:count,text};
 }
}
export function matrixFor(frame){if(typeof frame!=='string'||frame.length>470)throw Error('Invalid QR frame size.');return qrcodegen.QrCode.encodeText(frame,qrcodegen.QrCode.Ecc.MEDIUM);}
export function drawQR(canvas,frame){const qr=matrixFor(frame),scale=Math.max(3,Math.floor(480/(qr.size+8)));canvas.width=canvas.height=(qr.size+8)*scale;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#000';for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.getModule(x,y))c.fillRect((x+4)*scale,(y+4)*scale,scale,scale);}
export function decodePixels(data,width,height){if(!(data instanceof Uint8Array||data instanceof Uint8ClampedArray)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>1280||height>1280||data.length!==width*height*4)throw Error('Invalid scanner image dimensions.');return jsQR(data,width,height,{inversionAttempts:'attemptBoth'})?.data||null;}

// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateIdentity,exportIdentity,importIdentity,seal,open,MAX_MESSAGE} from '../apps/cipher/protocol.js';
import {framesFor,Collector,matrixFor,decodePixels} from '../apps/cipher/qr.js';

// Exercise the complete recovery -> message -> QR -> authenticated-read path
// with actual crypto and encoder/decoder code. Pixels are synthetic; this does
// not exercise a camera, browser file picker or physical offline isolation.
test('restored identities carry a maximum UTF-8 message through every rendered QR frame',async()=>{
  const backupPhrase='fictional recovery orchard lantern 42';
  const conversation='fictional independent conversation river 42';
  const sender=await importIdentity(await exportIdentity(await generateIdentity(),backupPhrase),backupPhrase);
  const recipient=await importIdentity(await exportIdentity(await generateIdentity(),backupPhrase),backupPhrase);
  const text='\ufeff\n\u0000'+'🛡'.repeat(510)+'abc';
  assert.equal(Buffer.byteLength(text,'utf8'),MAX_MESSAGE);
  const encrypted=await seal(sender,JSON.stringify(recipient.card),text,conversation);
  const frames=await framesFor(encrypted),collector=new Collector();
  assert.ok(frames.length>1);
  let received;
  for(const frame of [...frames].reverse()){
    const qr=matrixFor(frame),scale=4,width=(qr.size+8)*scale;
    const pixels=new Uint8ClampedArray(width*width*4).fill(255);
    for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.getModule(x,y)){
      for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){
        const at=(((y+4)*scale+yy)*width+(x+4)*scale+xx)*4;
        pixels[at]=pixels[at+1]=pixels[at+2]=0;
      }
    }
    const decoded=decodePixels(pixels,width,width);
    assert.equal(decoded,frame,'every actual QR matrix must decode to its exact numbered frame');
    received=await collector.add(decoded);
  }
  assert.equal(received.text,encrypted);
  assert.equal(received.received,frames.length);
  const seen=new Set(),senderCard=JSON.stringify(sender.card);
  await assert.rejects(open(recipient,senderCard,received.text,'incorrect fictional conversation',seen));
  assert.equal(seen.size,0,'a wrong independent secret cannot consume the replay slot');
  assert.equal(await open(recipient,senderCard,received.text,conversation,seen),text);
  assert.equal(seen.size,1);
  await assert.rejects(open(recipient,senderCard,received.text,conversation,seen),/already opened/);
});

// SPDX-License-Identifier: GPL-3.0-or-later
export class SessionScope {
  constructor(onLock,{idleMs=120000,schedule=setTimeout,cancel=clearTimeout}={}) {
    this.generation=0; this.onLock=onLock; this.idleMs=idleMs;
    this.schedule=schedule; this.cancel=cancel; this.timer=null;
  }
  invalidate(){return ++this.generation;}
  current(token){return token===this.generation;}
  touch(){if(this.timer!==null)this.cancel(this.timer);this.timer=this.schedule(()=>this.lock('Session locked after two minutes without activity.'),this.idleMs);}
  lock(reason='Session cleared.') {
    this.invalidate();if(this.timer!==null)this.cancel(this.timer);this.timer=null;
    this.onLock(reason);
  }
}

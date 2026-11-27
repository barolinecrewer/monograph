/**
 * bloub-bots — bot mascots become bloub (github.com/jeremy-prt/bloub, MIT) morphing
 * avatars: shape + colour from the bot's picker, idle/working animation ranges.
 * Also: bot-chat name pill, no wordmark on empty bot chats, and a mascot button
 * in the sidebar footer that switches Sessions <-> Bots.
 */
import { host } from '@hermes/plugin-sdk'

// ---- bundled bloub engine (MIT © Jérémy Perret) ----
const __bloub = (() => {
var E=Math.PI*2,d=(e,t=0,n=1)=>e<t?t:e>n?n:e,m=(e,t,n)=>e+(t-e)*n,w={easeOutCubic:e=>1-(1-e)**3,easeInOutCubic:e=>e<.5?4*e**3:1-(-2*e+2)**3/2,easeOutQuint:e=>1-(1-e)**5};function F(e,t,n=0){let r=e/t*E;return .55*Math.sin(r+n)+.3*Math.sin(2*r+n*1.7+1.1)+.15*Math.sin(3*r+n*2.3+2.4)}function q(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let n=Math.imul(t^t>>>15,1|t);return n=n+Math.imul(n^n>>>7,61|n)^n,((n^n>>>14)>>>0)/4294967296}}var p=e=>Math.round(e*100)/100;function de(e,t=.55,n=.62){let r=(e%360+360)%360,o=(1-Math.abs(2*n-1))*t,s=o*(1-Math.abs(r/60%2-1)),i=n-o/2,[c,l,a]=r<60?[o,s,0]:r<120?[s,o,0]:r<180?[0,o,s]:r<240?[0,s,o]:r<300?[s,0,o]:[o,0,s],u=h=>Math.round((h+i)*255).toString(16).padStart(2,"0");return`#${u(c)}${u(l)}${u(a)}`}function ve(e,t,n,r,o=1){let s=e.phase+t*e.speed*E,i=Math.cos(e.tilt),c=Math.sin(e.tilt),l=Math.sqrt(Math.max(0,1-e.k*e.k)),a=64,u=e.sweep*E,h="",f="",y=null;for(let M=0;M<=a;M++){let b=s+M/a*u,P=Math.cos(b),A=Math.sin(b),k=e.a*(P*i+A*-c*e.k)+e.cx,Y=e.a*(P*c+A*i*e.k)+e.cy,B=e.a*A*l<0,_=p(k*n),U=p(Y*n),Q=B!==y?"M":"L";B?f+=`${Q}${_} ${U}`:h+=`${Q}${_} ${U}`,y=B}let x=Math.cos(e.tilt)*e.a*n,S=Math.sin(e.tilt)*e.a*n;return{id:r,front:h,back:f,width:e.width*n,opacity:o,grad:{x1:p(e.cx*n-x),y1:p(e.cy*n-S),x2:p(e.cx*n+x),y2:p(e.cy*n+S),stops:[de(e.hue),de(e.hue+e.hueSpan*.5),de(e.hue+e.hueSpan)]}}}var v=q(659918),fe=Array.from({length:6},(e,t)=>({a:1.3+v()*.1,k:.05+v()*.4,tilt:t/6*Math.PI+v()*.5,speed:3+v()*.7,phase:v()*E,sweep:.6+v()*.25,hue:t*360/6+v()*30,hueSpan:60+v()*60,width:.05+v()*.012,cx:0,cy:.1})),De=Array.from({length:4},(e,t)=>({a:.78+t*.2,k:.05+t*.02,tilt:-.62+t*.05,speed:.3,phase:.06*t,sweep:.4,hue:95+t*62,hueSpan:100,width:.05,cx:0,cy:-.12})),ye=[-.557,-.013,.532],xe=.165,be=1.25,ze=q(48879),Tt=Array.from({length:5},(e,t)=>({birth:t*.2,angle:ze()*E,rho:.58+ze()*.18}));function Fe(e,t){let n=[];for(let r of Tt){let o=e-r.birth;if(o<0||o>.62)continue;let s=r.rho*Math.pow(.75,o*10),i=r.angle+o*100*Math.PI/180;n.push({x:Math.cos(i)*s*t,y:Math.sin(i)*s*t,r:(.04+.028*d(o/.55))*t,depth:d(1-s/.8),opacity:d(o/.06)*d((.62-o)/.08)})}return n}var Le=q(49383),Ne=Array.from({length:4},(e,t)=>{let n=t-1.5;return{a:.85*(1+n*.03),k:.15/.85*(1+n*.16),tilt:34*Math.PI/180+n*.035,speed:210/360,phase:-t*.045+Le()*.012,sweep:.34,hue:t*85+Le()*20,hueSpan:80,width:.095,cx:0,cy:0}}),Ye=.129,He="#2496e8",Ge=-42,ge=1.003,Xe=.15,Ve=1.14,qe=.054;var K=15.46,W=.186,j=.412,Z={yaw:28.49,pitch:28.62,roll:-13},ie=e=>e*Math.PI/180;function se(e,t,n){let r=Math.cos(n),o=Math.sin(n);return[[e[0]*r+t[0]*o,e[1]*r+t[1]*o,e[2]*r+t[2]*o],[t[0]*r-e[0]*o,t[1]*r-e[1]*o,t[2]*r-e[2]*o]]}function ae(e,t,n=K){let r=[0,0,1],o=[1,0,0],s=[0,1,0];[r,o]=se(r,o,ie(e.yaw)),[s,r]=se(s,r,ie(e.pitch)),[o,s]=se(o,s,ie(e.roll));let i=c=>{let[l,a]=se(r,o,ie(n*c));return{x:l[0]*t,y:l[1]*t,a:a[0],b:a[1],c:s[0],d:s[1],depth:l[2]}};return[i(-1),i(1)]}var Ue=q(24301),Qe=(()=>{let e=[],t=1.4;for(;t<900;)e.push(t),t+=1.9+Ue()*2.7,Ue()<.18&&(e.push(t),t+=.24);return e})(),zt=.18;function Lt(e){for(let t=0;t<Qe.length;t++){let n=Qe[t];if(e<n)break;let r=(e-n)/zt;if(r>=0&&r<=1)return r<.45?1-r/.45:(r-.45)/.55}return 1}function Ke(e,t={}){let{wander:n=1,blink:r=!0,float:o=!0}=t;return{dYaw:(F(e,11.3,.4)*5.5+F(e,3.7,2.1)*1.6)*n,dPitch:(F(e,9.1,1.3)*4.2+F(e,4.3,.7)*1.3)*n,dRoll:F(e,13.7,3.2)*2.2*n,lid:r?Lt(e):1,driftX:o?F(e,7.9,1.9)*.006:0,driftY:o?F(e,5.3,.3)*.007:0,breath:o?1+Math.sin(e/3.4*Math.PI*2)*.005:1}}function We(e){return .06+.94*d(e)}var z=(e,t,n=0,r=1)=>({w:e,h:t,tilt:n,open:r}),R=(e,t,n=0,r=1)=>[z(e,t,n,r),z(e,t,-n,r)],Se=[{id:"neutre",gaze:{...Z},split:K,eyes:[z(W,j),z(W,j)]},{id:"attentif",gaze:{yaw:4,pitch:5,roll:-4},split:16,eyes:R(.21,.44)},{id:"surpris",gaze:{yaw:3,pitch:-3,roll:0},split:19,eyes:R(.45,.47)},{id:"excite",gaze:{yaw:6,pitch:-14,roll:0},split:19.5,eyes:R(.4,.56,-10)},{id:"heureux",gaze:{yaw:5,pitch:9,roll:0},split:17,eyes:R(.27,.17,14)},{id:"hilare",gaze:{yaw:4,pitch:14,roll:0},split:18,eyes:R(.34,.13,20)},{id:"colere",gaze:{yaw:3,pitch:7,roll:0},split:17,eyes:R(.34,.15,30)},{id:"triste",gaze:{yaw:3,pitch:-13,roll:0},split:16,eyes:R(.22,.4,-28)},{id:"effraye",gaze:{yaw:2,pitch:-20,roll:0},split:20.5,eyes:R(.4,.6)},{id:"mefiant",gaze:{yaw:12,pitch:6,roll:-6},split:16,eyes:[z(.21,.4),z(.22,.15)]},{id:"confus",gaze:{yaw:-14,pitch:3,roll:8},split:16.5,eyes:[z(.2,.44,-18),z(.28,.17,14)]},{id:"curieux",gaze:{yaw:16,pitch:-9,roll:-15},split:16.5,eyes:[z(.24,.46,-8),z(.2,.38,-8)]},{id:"fier",gaze:{yaw:5,pitch:17,roll:0},split:17,eyes:R(.3,.15,18)},{id:"timide",gaze:{yaw:-19,pitch:-14,roll:-7},split:14,eyes:R(.17,.3)},{id:"blase",gaze:{yaw:-22,pitch:2,roll:0},split:16,eyes:R(.3,.12)},{id:"somnolent",gaze:{yaw:6,pitch:-9,roll:-3},split:16,eyes:R(.2,.42,0,.42)}],Ee=new Map(Se.map(e=>[e.id,e]));var je=(e,t,n)=>({w:m(e.w,t.w,n),h:m(e.h,t.h,n),tilt:m(e.tilt??0,t.tilt??0,n),open:m(e.open,t.open,n)});function Ze(e,t,n){return{id:t.id,gaze:{yaw:m(e.gaze.yaw,t.gaze.yaw,n),pitch:m(e.gaze.pitch,t.gaze.pitch,n),roll:m(e.gaze.roll,t.gaze.roll,n)},split:m(e.split,t.split,n),eyes:[je(e.eyes[0],t.eyes[0],n),je(e.eyes[1],t.eyes[1],n)]}}var Je={egg:[.8369,.8424,.8497,.8585,.8674,.8775,.8878,.8983,.9089,.9185,.9288,.9374,.9445,.9504,.9543,.9559,.9555,.9519,.9466,.9389,.9302,.9193,.9085,.8969,.8852,.8734,.8625,.8513,.8411,.8325,.8243,.8179,.8137,.8112,.8102,.8128,.8178,.8262,.8374,.8518,.8702,.8922,.9169,.9446,.9741,1.0023,1.0267,1.0433,1.0481,1.0393,1.0216,.997,.9697,.9418,.9169,.8949,.876,.8604,.849,.8394,.8337,.8314,.8305,.8326],hexagon:[.921,.9282,.9441,.9706,.9984,1.0059,.9896,.9562,.929,.9124,.9047,.9058,.9157,.9349,.9642,.9873,.9882,.9665,.9336,.9105,.8968,.8918,.8955,.908,.9293,.9611,.982,.9812,.959,.9282,.9089,.8978,.8964,.9026,.9189,.9439,.9778,.999,.9964,.9713,.9439,.9274,.9196,.9206,.9308,.9502,.9799,1.0121,1.0226,1.0071,.9752,.951,.9366,.9316,.9351,.9485,.9711,1.0026,1.0213,1.0155,.9863,.9547,.9347,.9232],triangle:[.7819,.8211,.8747,.944,1.0223,1.096,1.1401,1.134,1.0808,1.0047,.9265,.8603,.8104,.773,.745,.7273,.7151,.7118,.7148,.7245,.7427,.768,.8037,.8518,.9148,.9876,1.0583,1.1073,1.1109,1.0667,.994,.9164,.8482,.7948,.7555,.7261,.7056,.6925,.6859,.6869,.6938,.7084,.7305,.7615,.804,.8595,.9311,1.0092,1.0791,1.1171,1.1054,1.0501,.9779,.905,.845,.799,.7656,.7413,.7258,.716,.7146,.7204,.733,.7528]};var Pe=Array.from({length:64},(e,t)=>t/64*E),ce=Pe.map(Math.cos),le=Pe.map(Math.sin);function ue(e,t={}){return{radii:[...Je[e]],rot:0,cx:0,cy:0,sx:1,sy:1,...t}}function H(e,t={}){return{radii:new Array(64).fill(e),rot:0,cx:0,cy:0,sx:1,sy:1,...t}}function et(e,t,n,r){let o=r??{radii:new Array(64),rot:0,cx:0,cy:0,sx:1,sy:1};for(let i=0;i<64;i++)o.radii[i]=m(e.radii[i]??1,t.radii[i]??1,n);let s=t.rot-e.rot;for(;s>Math.PI;)s-=E;for(;s<-Math.PI;)s+=E;return o.rot=e.rot+s*n,o.cx=m(e.cx,t.cx,n),o.cy=m(e.cy,t.cy,n),o.sx=m(e.sx,t.sx,n),o.sy=m(e.sy,t.sy,n),o}function J(e,t,n=[]){let r=Math.cos(e.rot),o=Math.sin(e.rot);for(let s=0;s<64;s++){let i=e.radii[s]??1,c=i*(ce[s]??0),l=i*(le[s]??0),a=c*r-l*o,u=c*o+l*r,h=n[s]??{x:0,y:0};h.x=(a*e.sx+e.cx)*t,h.y=(u*e.sy+e.cy)*t,n[s]=h}return n.length=64,n}function tt(e,t=1/6){let n=e.length;if(n<3)return"";let r=e[0],o=`M${p(r.x)} ${p(r.y)}`;for(let s=0;s<n;s++){let i=e[(s-1+n)%n],c=e[s],l=e[(s+1)%n],a=e[(s+2)%n],u=c.x+(l.x-i.x)*t,h=c.y+(l.y-i.y)*t,f=l.x-(a.x-c.x)*t,y=l.y-(a.y-c.y)*t;o+=`C${p(u)} ${p(h)} ${p(f)} ${p(y)} ${p(l.x)} ${p(l.y)}`}return`${o}Z`}function G(e,t,n){let r=new Array(64).fill(0),o=e.length;for(let s=0;s<64;s++){let i=ce[s]??0,c=le[s]??0,l=0;for(let a=0;a<o;a++){let u=e[a],h=e[(a+1)%o],f=h.x-u.x,y=h.y-u.y,x=i*y-c*f;if(Math.abs(x)<1e-9)continue;let S=u.x-t,M=u.y-n,b=(S*y-M*f)/x,P=(S*c-M*i)/x;b>l&&P>=0&&P<=1&&(l=b)}r[s]=l}return r}function X(e,t,n,r,o,s,i=96){let c=r-e,l=o-t,a=Math.hypot(c,l)||1e-6,u=Math.atan2(l,c),h=Math.acos(Math.max(-1,Math.min(1,(n-s)/a))),f=[];for(let y=0;y<=i/2;y++){let x=u+h+(E-2*h)*y/(i/2);f.push({x:e+Math.cos(x)*n,y:t+Math.sin(x)*n})}for(let y=0;y<=i/2;y++){let x=u-h+2*h*y/(i/2);f.push({x:r+Math.cos(x)*s,y:o+Math.sin(x)*s})}return f}function pe(e,t){let n=e.length,r=(t/E%1+1)%1*n,o=Math.floor(r);return m(e[o%n]??1,e[(o+1)%n]??1,r-o)}function nt(e,t=1,n=1){return Pe.map((r,o)=>{let s=Math.abs((ce[o]??0)/t)**e,i=Math.abs((le[o]??0)/n)**e;return(s+i)**(-1/e)})}function rt(e){let t=new Array(64).fill(0);for(let n=0;n<64;n++){let r=ce[n]??0,o=le[n]??0,s=0;for(let i of e){let c=r*i.x+o*i.y,l=c*c-(i.x*i.x+i.y*i.y-i.r*i.r);if(l<0)continue;let a=c+Math.sqrt(l);a>s&&(s=a)}t[n]=s}return t}function vt(e,t,n=10){let r=e.length,o=[],s=(i,c)=>{let l=c.x-i.x,a=c.y-i.y,u=Math.hypot(l,a)||1;return Math.atan2(-l/u,a/u)};for(let i=0;i<r;i++){let c=e[(i-1+r)%r],l=e[i],a=e[(i+1)%r],u=s(c,l),f=s(l,a)-u;for(;f>Math.PI;)f-=E;for(;f<-Math.PI;)f+=E;for(let y=0;y<=n;y++){let x=u+f*y/n;o.push({x:l.x+Math.cos(x)*t,y:l.y+Math.sin(x)*t})}}return o}function Me(e,t,n,r=0){let o=r*Math.PI/180,s=Array.from({length:e},(i,c)=>{let l=o+c/e*E;return{x:Math.cos(l)*(t-n),y:Math.sin(l)*(t-n)}});return G(vt(s,n),0,0)}function ot(e,t=1){if(e.length<3)return"";let n="";for(let r=0;r<e.length;r++){let o=e[r];n+=`${r===0?"M":"L"}${p(o.x*t)} ${p(o.y*t)}`}return`${n}Z`}function it(e,t){let n=Math.max(e,.01)/2,r=Math.max(t,.01)/2,o=Math.min(n,r);return`M${p(-n)} ${p(-r+o)}A${p(o)} ${p(o)} 0 0 1 ${p(-n+o)} ${p(-r)}L${p(n-o)} ${p(-r)}A${p(o)} ${p(o)} 0 0 1 ${p(n)} ${p(-r+o)}L${p(n)} ${p(r-o)}A${p(o)} ${p(o)} 0 0 1 ${p(n-o)} ${p(r)}L${p(-n+o)} ${p(r)}A${p(o)} ${p(o)} 0 0 1 ${p(-n)} ${p(r-o)}Z`}function he(e,t=1){let n=Math.max(...e);if(n<=0)return e;let r=t/n;return e.map(o=>o*r)}var Dt=Array.from({length:64},(e,t)=>t/64*Math.PI*2),Ft=he(Dt.map(e=>1+.075*Math.cos(2*e+.5)+.035*Math.cos(3*e+2.1)),1.02),Nt=he(rt([{x:-.44,y:.2,r:.54},{x:.46,y:.2,r:.5},{x:.02,y:.3,r:.6},{x:-.24,y:-.3,r:.48},{x:.3,y:-.24,r:.44}]),1.02),Yt=he(G(X(0,.28,.66,0,-.96,.05),0,0),1.04),Ht=G(X(-.42,0,.62,.42,0,.62),0,0),Ae=[{id:"cercle",radii:new Array(64).fill(1)},{id:"galet",radii:Ft},{id:"squircle",radii:he(nt(4.2),1.15)},{id:"capsule",radii:Ht},{id:"triangle",radii:Me(3,1.12,.34,-90)},{id:"hexagone",radii:Me(6,1.04,.26,0)},{id:"nuage",radii:Nt},{id:"goutte",radii:Yt}],st=new Map(Ae.map(e=>[e.id,e]));var Gt=[{id:"encre",hex:"#0a0a0c"},{id:"brun",hex:"#8b5e3c"},{id:"rouge",hex:"#e8483f"},{id:"orange",hex:"#f08a24"},{id:"ambre",hex:"#f0b429"},{id:"vert",hex:"#3ecf8e"},{id:"turquoise",hex:"#2fbfa0"},{id:"bleu",hex:"#3b93f0"},{id:"violet",hex:"#8b5cf6"},{id:"rose",hex:"#e152b0"},{id:"gris",hex:"#a3a3a3"},{id:"creme",hex:"#f1efe9"}],On=new Map(Gt.map(e=>[e.id,e]));function at(e,t,n){let r=c=>{let l=parseInt(c.slice(1),16);return[l>>16&255,l>>8&255,l&255]},o=r(e),s=r(t);return`#${o.map((c,l)=>Math.round(c+(s[l]-c)*n)).map(c=>c.toString(16).padStart(2,"0")).join("")}`}var V=(e,t)=>[{w:e,h:t,open:1},{w:e,h:t,open:1}];function O(e={}){return{sil:H(1),offX:0,offY:0,gaze:{...Z},split:K,eyes:V(W,j),eyeAlpha:1,bodyAlpha:1,dots:[],arcs:[],notif:null,dotsBehind:!1,...e}}var pt=-.1875,Xt=G(X(0,-.505,.132,0,.13,.075),0,pt),Vt=G(X(0,-.2535,.1345,0,.2535,.1345),0,0),qt=(e={})=>({radii:[...Xt],rot:0,cx:0,cy:pt,sx:1,sy:1,...e}),Ut=(e={})=>({radii:[...Vt],rot:0,cx:0,cy:0,sx:1,sy:1,...e}),Qt=ot(X(0,0,.118,0,.172,.012)),ct=.213;function lt(e){return ue("triangle",{rot:e,cx:-ct*Math.sin(e),cy:ct*Math.cos(e)})}function ut(e,t){let n=((e-t*.5)/1.5%1+1)%1,r=n<.5?.5-.5*Math.cos(n*E):0;return d(r*2)}var ee=[{id:"idle",duration:2.4,morph:.45,blinkIn:!1,baseFace:!0,baseBody:!0,pose:()=>O()},{id:"thinking",duration:2.6,morph:.4,baseFace:!1,baseBody:!1,blinkIn:!0,pose:e=>{let t=ut(e,1),n=.3+.7*w.easeOutCubic(d(e/.3));return O({sil:H(xe*(1+(be-1)*t),{cx:ye[1]}),eyeAlpha:0,dots:[0,2].map(r=>{let o=ut(e,r);return{x:ye[r]*n,y:0,r:xe*(1+(be-1)*o),opacity:.55+.45*o}})})}},{id:"wink",duration:1.6,morph:.3,blinkIn:!0,baseFace:!1,baseBody:!0,pose:()=>O({gaze:{yaw:-5.37,pitch:4.55,roll:6.7},split:16.25,eyes:[{w:.236,h:.464,open:1},{w:.447,h:.089,open:1}]})},{id:"wide",duration:1.8,morph:.55,blinkIn:!0,baseFace:!1,baseBody:!0,pose:()=>O({gaze:{yaw:6.92,pitch:-21.96,roll:11.6},split:18.43,eyes:V(.356,.875)})},{id:"alert",duration:2.4,minDuration:2,morph:.45,baseFace:!1,baseBody:!1,blinkIn:!1,pose:e=>{let t=d(e/1.5),n=w.easeInOutCubic(t)*.82-.087,r=e>1.6?d((e-1.6)/.4):0,o=n*(1-r)+.1*r,s=Math.sin(e*2.5*E)*.005,i=17.7*Math.PI/180;return O({sil:Ut({rot:i,cx:o,cy:-.325-s}),eyeAlpha:0,dots:[{x:o-Math.sin(i)*.58,y:-.325+Math.cos(i)*.58+s*2.8,r:.118,d:Qt,rot:i*180/Math.PI,opacity:1}]})}},{id:"notify",duration:2.2,morph:.5,blinkIn:!0,baseFace:!1,baseBody:!0,pose:e=>{let t=d(e/.45),n=1+(Ve-1)*Math.sin(t*Math.PI)*(1-t*.35),r=Xe*(t<1?n:1),o=Ge*Math.PI/180;return O({gaze:{yaw:-21.94,pitch:-5.82,roll:-12.2},split:18.89,eyes:V(.505,.498),notif:{x:Math.cos(o)*ge,y:Math.sin(o)*ge,r,notch:r+qe}})}},{id:"exclaim",duration:2,morph:.45,baseFace:!1,baseBody:!1,blinkIn:!1,pose:()=>O({sil:qt(),eyeAlpha:0,dots:[{x:-.012,y:.526,r:.113,opacity:1}]})},{id:"sleep",duration:2.4,morph:.5,baseFace:!1,baseBody:!1,blinkIn:!1,pose:e=>O({sil:H(.1585,{cy:.11+Math.sin(e*(E/.6))*.19}),eyeAlpha:0})},{id:"egg",duration:1.8,morph:.4,baseFace:!1,baseBody:!1,blinkIn:!0,pose:()=>O({sil:ue("egg"),gaze:{yaw:19.97,pitch:26.01,roll:-17.1},split:11.07,eyes:V(.164,.385)})},{id:"hexagon",duration:1.6,morph:.4,baseFace:!1,baseBody:!1,blinkIn:!0,pose:()=>O({sil:ue("hexagon"),gaze:{yaw:23.11,pitch:24.42,roll:-13.3},split:13.37,eyes:V(.177,.411)})},{id:"play",duration:2,morph:.5,baseFace:!1,baseBody:!1,blinkIn:!0,pose:e=>{let t=d(e/.35)*d((2.2-e)/.5);return O({sil:lt(0),gaze:{yaw:12,pitch:-8,roll:-6},split:15,eyes:V(.18,.34),arcs:De.map((n,r)=>({id:`sw${r}`,seed:{...n,cx:.45-e*.42},t:e,opacity:t}))})}},{id:"orbit",duration:3.4,minDuration:2.5,morph:.6,baseFace:!1,baseBody:!1,blinkIn:!1,pose:e=>{let t=w.easeInOutCubic(d(e/.35)),n=-E*1.25*e*t,r=w.easeInOutCubic(d((e-1.6)/.9)),o=lt(n),s=H(1,{rot:n}),i={radii:o.radii.map((l,a)=>l+(s.radii[a]-l)*r),rot:n,cx:o.cx*(1-r),cy:o.cy*(1-r),sx:1,sy:1},c=d(e/.8)*d((3.6-e)/.9);return O({sil:i,gaze:{yaw:Z.yaw+Math.sin(e*6.5)*65*(1-r),pitch:-4+r*32,roll:-13},eyes:V(.18,.34+r*.07),arcs:fe.map((l,a)=>({id:`rg${a}`,seed:l,t:e,opacity:c*d((e-a*.13)/.3)}))})}},{id:"swirl",duration:1.3,minDuration:1.3,morph:.3,baseFace:!0,baseBody:!0,blinkIn:!0,pose:e=>O({arcs:fe.slice(0,3).map((t,n)=>({id:`sw${n}`,seed:t,t:e,opacity:d((e-n*.06)/.14)*d((1.22-e)/.34)}))})},{id:"burst",duration:2.6,minDuration:2.4,morph:.4,baseFace:!1,baseBody:!1,blinkIn:!1,pose:e=>{let t=1-.834*w.easeOutQuint(d(e/.7)),n=w.easeOutQuint(d((e-1.7)/.7));return O({sil:H(t+(1-t)*n),eyeAlpha:d((e-1.85)/.4),dots:Fe(e,1),dotsBehind:!0})}},{id:"comet",duration:2.4,minDuration:2.4,morph:.45,baseFace:!1,baseBody:!1,blinkIn:!1,pose:e=>{let t=1-(1-Ye)*w.easeOutQuint(d(e/.55)),n=w.easeOutQuint(d((e-1.85)/.6)),r=d((e-.15)/.25)*d((1.95-e)/.3);return O({sil:H(t+(1-t)*n,{cy:Math.sin(d(e/1.7)*Math.PI)*.035}),eyeAlpha:d((e-2)/.35),arcs:Ne.map((o,s)=>({id:`cm${s}`,seed:o,t:e,opacity:r}))})}}],N=new Map(ee.map(e=>[e.id,e]));var D=100,ht=5.5+1.6,mt=4.2+1.3,Kt=.006,Wt=.007;function dt(e,t,n){let r=[],o=ae(e.gaze,D,e.split);for(let s=0;s<2;s++){let i=o[s];if(i.depth<=.02)continue;let c=e.eyes[s],l=(c.tilt??0)*Math.PI/180,a=Math.cos(l),u=Math.sin(l),h=i.a*a+i.c*u,f=i.b*a+i.d*u,y=-i.a*u+i.c*a,x=-i.b*u+i.d*a,S=Math.max(c.w*D,.01)/2,M=Math.max(c.h*D,.01)/2,b=Math.min(S,M),P=M>S,A=P?M-b:S-b,k=pe(n,Math.atan2(i.y,i.x)-t.rot);r.push({x:i.x*k,y:i.y*k,ax:(P?y:h)*A,ay:(P?x:f)*A,r:b,m:[h,f,y,x]})}return r}function jt(e,t,n,r,o){let s=r-t,i=o-n,c=s*s+i*i,l=1/0,a=0,u=0;for(let f=0;f<e.length;f++){let y=e[f],x=c>0?((y.x-t)*s+(y.y-n)*i)/c:0;x=x<0?0:x>1?1:x;let S=t+x*s-y.x,M=n+x*i-y.y,b=S*S+M*M;b<l&&(l=b,a=S,u=M)}let h=Math.sqrt(l);return{d:h,ux:h>1e-9?a/h:0,uy:h>1e-9?u/h:0}}var Zt=Math.hypot(Kt,Wt)*D;function ft(e,t,n,r){let o=1/0,s=0,i=0;for(let c of t){let l=c.x+n,a=c.y+r,u=jt(e,l-c.ax,a-c.ay,l+c.ax,a+c.ay),[h,f,y,x]=c.m,S=c.r*Math.hypot(h*u.ux+f*u.uy,y*u.ux+x*u.uy)+Zt;u.d-S<o&&(o=u.d-S,s=u.ux,i=u.uy)}return{marge:o,ux:s,uy:i}}var yt=12,Jt=8;function en(e){if(!e.length)return{x:0,y:0};let t=(b,P)=>{let A=1/0;for(let k of e)A=Math.min(A,ft(k.contour,k.empreintes,b,P).marge);return A},n=1/0;for(let b of e)n=Math.min(n,ft(b.calContour,b.reference,0,0).marge);let r=0,o=0,s=e[0].empreintes;for(let b of s)r-=b.x/s.length,o-=b.y/s.length;let i=Math.max(.35*D,Math.hypot(r,o)*1.25);n=Math.min(n,t(r,o));let c=t(0,0);if(c>=n&&c>=0)return{x:0,y:0};let l=Math.max(n,0),a=0,u=0,h=1/0,f=0,y=0,x=c;for(let b=0;b<yt;b++){let P=b/yt*Math.PI*2,A=Math.cos(P),k=Math.sin(P);if(t(A*i,k*i)<l){for(let B of[.3,.6,1]){let _=t(A*i*B,k*i*B);_>x&&(x=_,f=A*i*B,y=k*i*B)}continue}let Y=0,T=i;for(let B=0;B<Jt;B++){let _=(Y+T)/2;t(A*_,k*_)>=l?T=_:Y=_}T<h&&(h=T,a=A*T,u=k*T)}let S=h===1/0?f:a,M=h===1/0?y:u;return{x:+(S/D).toFixed(6),y:+(M/D).toFixed(6)}}function tn(e,t,n){return e.baseFace&&n?{gaze:n.gaze,split:n.split,eyes:n.eyes}:{gaze:t.gaze,split:t.split,eyes:t.eyes}}function nn(e){let t=r=>JSON.stringify([r.gaze,r.split,r.eyes,r.sil.rot,r.sil.cx,r.sil.cy,r.sil.sx,r.sil.sy]);if(t(e.pose(0))===t(e.pose(e.duration)))return[0];let n=3;return Array.from({length:n},(r,o)=>o/(n-1)*e.duration)}function rn(e,t,n){let r=[];for(let o of nn(e)){let s=e.pose(o),i=J({...s.sil,radii:t},D),c=J(s.sil,D),l=tn(e,s,n),a=[];for(let u of[-ht,ht])for(let h of[-mt,mt])a.push({...l,gaze:{yaw:l.gaze.yaw+u,pitch:l.gaze.pitch+h,roll:l.gaze.roll}});for(let u of a)r.push({empreintes:dt(u,s.sil,t),reference:dt(u,s.sil,s.sil.radii),contour:i,calContour:c})}return en(r)}var Ie={x:0,y:0},we=(e,t)=>`${e}|${t??""}`;function on(){return new Map(Ae.map(e=>{let t=new Map;for(let n of ee){if(!n.baseBody)continue;let r=n.baseFace?[null,...Se]:[null];for(let o of r)t.set(we(n.id,o?.id??null),rn(n,e.radii,o))}return[e.radii,t]}))}var sn=on();function ke(e,t,n){if(!e)return Ie;let r=sn.get(e);return r?r.get(we(t,n))??r.get(we(t,null))??Ie:Ie}var $e={yaw:0,pitch:0,mix:0,spin:0,wander:1},an=(e,t,n)=>({yaw:m(e.yaw,t.yaw,n),pitch:m(e.pitch,t.pitch,n),mix:m(e.mix,t.mix,n),spin:m(e.spin,t.spin,n),wander:m(e.wander,t.wander,n)}),xt=(e,t,n)=>({w:m(e.w,t.w,n),h:m(e.h,t.h,n),open:m(e.open,t.open,n),tilt:m(e.tilt??0,t.tilt??0,n)});function bt(e,t,n){let r=1-n;return{sil:et(e.sil,t.sil,n),offX:m(e.offX,t.offX,n),offY:m(e.offY,t.offY,n),gaze:{yaw:m(e.gaze.yaw,t.gaze.yaw,n),pitch:m(e.gaze.pitch,t.gaze.pitch,n),roll:m(e.gaze.roll,t.gaze.roll,n)},split:m(e.split,t.split,n),eyes:[xt(e.eyes[0],t.eyes[0],n),xt(e.eyes[1],t.eyes[1],n)],eyeAlpha:m(e.eyeAlpha,t.eyeAlpha,n),bodyAlpha:m(e.bodyAlpha,t.bodyAlpha,n),dots:[...e.dots.map(o=>({...o,opacity:o.opacity*r})),...t.dots.map(o=>({...o,opacity:o.opacity*n}))],arcs:[...e.arcs.map(o=>({...o,id:`a${o.id}`,opacity:o.opacity*r})),...t.arcs.map(o=>({...o,id:`b${o.id}`,opacity:o.opacity*n}))],notif:n<.5?e.notif:t.notif,dotsBehind:n<.5?e.dotsBehind:t.dotsBehind}}var me=class e{scale;cur;prev=null;departFige=null;tCur=0;tPrev=0;blinkAt=-10;pts=[];shape=null;shapePrev=null;shapeAt=-10;expr=null;exprPrev=null;exprAt=-10;look=$e;lookPrev=$e;lookAt=-10;lookMorph=.24;static SHAPE_MORPH=.45;static LOOK_MORPH=.24;constructor(t=100,n="idle",r=null,o=null){this.scale=t,this.cur=n,this.shape=r,this.expr=o}setExpression(t,n=0){t!==this.expr&&(this.exprPrev=this.expr,this.expr=t,this.exprAt=n)}exprAtTime(t){let n=this.expr,r=this.exprPrev;if(!n||!r)return n;let o=(t-this.exprAt)/e.SHAPE_MORPH;return o>=1?n:Ze(r,n,w.easeOutQuint(d(o)))}setShape(t,n=0){t!==this.shape&&(this.shapePrev=this.shape,this.shape=t,this.shapeAt=n)}shapeAtTime(t){let n=this.shape,r=this.shapePrev;if(!n||!r)return n;let o=(t-this.shapeAt)/e.SHAPE_MORPH;if(o>=1)return n;let s=w.easeOutQuint(d(o));return n.map((i,c)=>m(r[c]??i,i,s))}setLook(t,n,r=e.LOOK_MORPH){t&&!Number.isFinite(t.yaw+t.pitch+t.mix+t.spin+t.wander)||(this.lookPrev=this.lookAtTime(n),this.look=t??$e,this.lookAt=n,this.lookMorph=r)}lookAtTime(t){let n=(t-this.lookAt)/this.lookMorph;return n>=1?this.look:an(this.lookPrev,this.look,w.easeOutQuint(d(n)))}posed(t,n,r,o){let s=t.pose(n);return t.baseBody&&r&&(s={...s,sil:{...s.sil,radii:r}}),t.baseFace&&o&&(s={...s,gaze:o.gaze,split:o.split,eyes:o.eyes}),s}decalageAtTime(t,n){let r=(s,i,c,l)=>{if(c===l)return l;let a=(t-s)/i;if(a>=1)return l;let u=w.easeOutQuint(d(a));return{x:m(c.x,l.x,u),y:m(c.y,l.y,u)}},o=s=>r(this.exprAt,e.SHAPE_MORPH,ke(s,n,this.exprPrev?.id??null),ke(s,n,this.expr?.id??null));return r(this.shapeAt,e.SHAPE_MORPH,o(this.shapePrev),o(this.shape))}get state(){return this.cur}reset(t,n){this.cur=t,this.prev=null,this.departFige=null,this.tCur=n,this.tPrev=n,this.blinkAt=-10}origine(t,n,r){if(this.departFige)return this.departFige;if(!this.prev)return null;let o=N.get(this.prev);return this.posed(o,Math.max(0,t-this.tPrev),n,r)}poseComposee(t){let n=N.get(this.cur),r=this.shapeAtTime(t),o=this.exprAtTime(t),s=this.posed(n,Math.max(0,t-this.tCur),r,o),i=t-this.tCur;if(i>=n.morph)return s;let c=this.origine(t,r,o);return c?bt(c,s,w.easeOutQuint(d(i/n.morph))):s}setState(t,n){if(t===this.cur)return;let r=N.get(this.cur).morph,o=this.prev!==null&&n-this.tCur<r;this.departFige=o?this.poseComposee(n):null,this.prev=this.cur,this.tPrev=this.tCur,this.cur=t,this.tCur=n,N.get(t)?.blinkIn&&(this.blinkAt=n)}sample(t){let n=this.scale,r=N.get(this.cur),o=this.shapeAtTime(t),s=this.exprAtTime(t),i=this.posed(r,Math.max(0,t-this.tCur),o,s),c=this.decalageAtTime(t,this.cur),l=t-this.tCur,a=l<r.morph?this.origine(t,o,s):null;if(a){let g=w.easeOutQuint(d(l/r.morph));i=bt(a,i,g);let L=this.prev;if(L){let I=this.decalageAtTime(t,L);c={x:m(I.x,c.x,g),y:m(I.y,c.y,g)}}}let u=i.eyeAlpha>.01,h=this.lookAtTime(t),f=Ke(t,{wander:u?h.wander:0,blink:u}),y={yaw:m(i.gaze.yaw,h.yaw,h.mix)+f.dYaw-h.spin,pitch:m(i.gaze.pitch,h.pitch,h.mix)+f.dPitch,roll:i.gaze.roll+f.dRoll},x=d((t-this.blinkAt)/.2),S=x<1?Math.abs(x*2-1):1,M=Math.min(f.lid,S),b=i.offX+f.driftX,P=i.offY+f.driftY,A={...i.sil,cx:i.sil.cx+b,cy:i.sil.cy+P,sy:i.sil.sy*f.breath},k=tt(J(A,n,this.pts)),Y=(g,L)=>pe(i.sil.radii,Math.atan2(L,g)-i.sil.rot),T=[];if(i.eyeAlpha>.01){let g=ae(y,n,i.split);for(let L=0;L<2;L++){let I=g[L];if(I.depth<=.02)continue;let ne=i.eyes[L],Re=Y(I.x,I.y),Ce=(ne.tilt??0)*Math.PI/180,re=Math.cos(Ce),oe=Math.sin(Ce),Bt=I.a*re+I.c*oe,_t=I.b*re+I.d*oe,Rt=-I.a*oe+I.c*re,Ct=-I.b*oe+I.d*re,Te=We(Math.min(M,ne.open));T.push({d:it(ne.w*n,ne.h*n),matrix:`matrix(${p(Bt)},${p(_t*Te)},${p(Rt)},${p(Ct*Te)},${p(I.x*Re+(b+c.x)*n)},${p(I.y*Re+(P+c.y)*n)})`,alpha:i.eyeAlpha*d(I.depth/.12)})}}let B=i.dots.filter(g=>g.opacity>.01&&g.r>5e-4).map(g=>({...g,x:(g.x+b)*n,y:(g.y+P)*n,r:g.r*n})),_=i.notif?Y(i.notif.x,i.notif.y):1,U=i.notif?(i.notif.x*_+b)*n:0,Q=i.notif?(i.notif.y*_+P)*n:0,$t=i.notif?{x:U,y:Q,r:i.notif.r*n}:null,Ot=i.notif?{x:U,y:Q,r:i.notif.notch*n}:null;return{bodyPath:k,bodyAlpha:i.bodyAlpha,eyes:T,dots:B,dotsBehind:i.dotsBehind,arcs:i.arcs.filter(g=>g.opacity>.01).map(g=>ve(g.seed,g.t,n,g.id,g.opacity)),notif:$t,notch:Ot}}};var gt=Math.max(...ee.map(e=>e.morph)),cn=10;var St=.1;function ln(e){return Math.max(gt,N.get(e)?.minDuration??gt)}function Oe(e,t){let n=Math.round(t/St)*St,r=Math.min(cn,Math.max(ln(e),n));return Math.round(r*100)/100}var Et=100,C=158,hn="http://www.w3.org/2000/svg",wt={circle:"cercle",blob:"galet",squircle:"squircle",pill:"capsule",triangle:"triangle",hexagon:"hexagone",cloud:"nuage",drop:"goutte"},sr=Object.keys(wt),Pt=[["idle",6],["wink",1.4],["idle",5],["wide",1.6],["idle",7],["swirl",1.6],["idle",5],["notify",2.2]],mn=[["thinking",3.2],["orbit",2.8],["thinking",2.6],["swirl",1.6],["play",2.4],["comet",2.6],["thinking",2.6],["burst",2.4]],Mt=e=>st.get(wt[e||""]||e||"")?.radii??null,dn=0,te=new Set,Be=0,At=0;var __io=typeof IntersectionObserver<"u"?new IntersectionObserver(es=>{for(let x of es)x.target.__vis=x.isIntersecting}):null;function kt(e){if(!te.size){Be=0;return}if(Be=requestAnimationFrame(kt),document.hidden||e-At<1e3/20)return;At=e;let t=performance.now()/1e3;for(let n of te){let el=n.el;if(!el.isConnected)continue;if(__io&&!el.__obs){el.__obs=1;__io.observe(el)}if(el.__vis===false)continue;n.tick(t)}}function It(){Be||(Be=requestAnimationFrame(kt))}var _e=class{el;engine;opts;uid="bl"+(dn++).toString(36);start=performance.now()/1e3;seq=Pt;idx=0;nextAt=0;constructor(t,n={}){this.opts={size:36,shape:"circle",color:"#f2f2f2",paper:"#0c0c0d",mode:"idle",expression:"neutre",...n},this.el=document.createElementNS(hn,"svg"),this.el.setAttribute("viewBox",`${-C} ${-C} ${C*2} ${C*2}`),this.el.setAttribute("aria-hidden","true"),this.el.setAttribute("data-bloub",""),this.el.style.display="block",this.el.style.overflow="visible",this.size(this.opts.size),t.appendChild(this.el),this.engine=new me(Et,"idle",Mt(this.opts.shape),Ee.get(this.opts.expression)??null),this.setMode(this.opts.mode,!0),this.draw(this.engine.sample(this.rel())),this.opts.mode!=="still"&&(te.add(this),It())}rel(){return performance.now()/1e3-this.start}size(t){this.el.setAttribute("width",String(t)),this.el.setAttribute("height",String(t))}setMode(t,n=!1){if(!n&&t===this.opts.mode)return;this.opts.mode=t,this.seq=t==="work"?mn:Pt,this.idx=0;let r=this.rel();this.engine.setState(this.seq[0][0],r),this.nextAt=r+Oe(this.seq[0][0],this.seq[0][1]),t==="still"?te.delete(this):(te.add(this),It())}set(t){let n=this.rel();t.shape!==void 0&&t.shape!==this.opts.shape&&(this.opts.shape=t.shape,this.engine.setShape(Mt(t.shape),n)),t.color!==void 0&&(this.opts.color=t.color),t.paper!==void 0&&(this.opts.paper=t.paper),t.size!==void 0&&t.size!==this.opts.size&&(this.opts.size=t.size,this.size(t.size)),t.expression!==void 0&&t.expression!==this.opts.expression&&(this.opts.expression=t.expression,this.engine.setExpression(Ee.get(t.expression)??null,n)),t.mode!==void 0&&this.setMode(t.mode),this.opts.mode==="still"&&this.draw(this.engine.sample(n))}tick(t){if(!this.el.isConnected){this.destroy();return}let n=this.el.getBoundingClientRect();if(!n.width||n.bottom<0||n.top>innerHeight)return;let r=this.rel();if(r>=this.nextAt){this.idx=(this.idx+1)%this.seq.length;let[o,s]=this.seq[this.idx];this.engine.setState(o,r),this.nextAt=r+Oe(o,s)}this.draw(this.engine.sample(r))}draw(t){let n=this.opts.color,r=this.opts.paper,o=this.uid,s=a=>{let u=a.color??(a.depth===void 0?n:at(r,n,a.depth));return a.d?`<path d="${a.d}" fill="${u}" opacity="${a.opacity}" transform="translate(${a.x} ${a.y}) rotate(${a.rot??0}) scale(${Et})"/>`:`<circle cx="${a.x}" cy="${a.y}" r="${a.r}" fill="${u}" opacity="${a.opacity}"/>`},i=t.dots.map(s).join(""),c=t.arcs.map(a=>`<linearGradient id="${o}-${a.id}" gradientUnits="userSpaceOnUse" x1="${a.grad.x1}" y1="${a.grad.y1}" x2="${a.grad.x2}" y2="${a.grad.y2}">${a.grad.stops.map((u,h)=>`<stop offset="${h/Math.max(1,a.grad.stops.length-1)}" stop-color="${u}"/>`).join("")}</linearGradient>`).join(""),l=a=>t.arcs.map(u=>`<path d="${u[a]}" stroke="url(#${o}-${u.id})" stroke-width="${u.width}" opacity="${u.opacity}"/>`).join("");this.el.innerHTML=`<defs><mask id="${o}-m" maskUnits="userSpaceOnUse" x="${-C}" y="${-C}" width="${C*2}" height="${C*2}"><path d="${t.bodyPath}" fill="#fff"/>`+t.eyes.map(a=>`<path d="${a.d}" transform="${a.matrix}" opacity="${a.alpha}" fill="#000"/>`).join("")+(t.notch?`<circle cx="${t.notch.x}" cy="${t.notch.y}" r="${t.notch.r}" fill="#000"/>`:"")+`</mask>${c}</defs><g fill="none" stroke-linecap="round">${l("back")}</g>`+(t.dotsBehind?`<g>${i}</g>`:"")+`<g opacity="${t.bodyAlpha}"><path d="${t.bodyPath}" fill="${r}"/><g mask="url(#${o}-m)"><rect x="${-C}" y="${-C}" width="${C*2}" height="${C*2}" fill="${n}"/></g></g>`+(t.dotsBehind?"":`<g>${i}</g>`)+(t.notif?`<circle cx="${t.notif.x}" cy="${t.notif.y}" r="${t.notif.r}" fill="${He}"/>`:"")+`<g fill="none" stroke-linecap="round">${l("front")}</g>`}destroy(){te.delete(this),this.el.remove()}};function ar(e,t){return new _e(e,t)}
const Bloub={Avatar:_e,SHAPES:sr,mount:ar};

return Bloub
})()
// Static mascots: every avatar renders once in the engine's 'still' mode (no rAF loop),
// then redraws after shape/colour morphs settle so it lands on the final pose.
const __settle = av => { clearTimeout(av.__st); av.__st = setTimeout(() => { if (av.el.isConnected) av.draw(av.engine.sample(av.rel() + 5)) }, 700) }
const mount = (el, opts = {}) => {
  const av = __bloub.mount(el, { ...opts, mode: 'still' })
  av.draw(av.engine.sample(av.rel() + 5)); __settle(av)
  const set = av.set.bind(av)
  av.set = o => {
    const shapeChanged = o.shape !== undefined && o.shape !== av.opts.shape
    const colorChanged = o.color !== undefined && o.color !== av.opts.color
    set({ ...o, mode: 'still' })
    if (shapeChanged) __settle(av); else if (colorChanged) av.draw(av.engine.sample(av.rel() + 5))
  }
  return av
}

// perf: ignore DOM churn inside chat transcripts (streaming tokens) — sidebar/chrome only
const __inThread = n => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest('[data-slot="thread"], svg[data-bloub], #mf-live, #perf-probe')) }
const __relevant = recs => { for (const r of recs) if (!__inThread(r.target)) return true; return false }
const __set = (el, k, v = '') => { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v) }
const __throttle = (fn, ms) => { let t = 0, last = 0; return () => { if (t) return; const wait = Math.max(0, ms - (performance.now() - last)); t = setTimeout(() => { t = 0; last = performance.now(); fn() }, wait) } }

const PAPER = '#141416'
const known = new Map()   // bot name -> { shape, color, title }
const faces = new WeakMap() // original svg -> { av, wrap }

const PRIMARY = { shape: 'circle', color: '#f4f4f4' }
// The colour is written into the SVG as an attribute: only a plain colour may pass.
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|(rgb|hsl)\([\d\s.,%]+\))$/i
const safeColor = (c, fallback = '#f2f2f2') => (typeof c === 'string' && COLOR.test(c.trim()) ? c.trim() : fallback)
function readFace(svg) {
  const isBlob = !svg.hasAttribute('data-hb-math')
  const body = svg.querySelector('[data-hb-body]') || svg.querySelector('path[fill], circle[fill], rect[fill]')
  let color = body?.getAttribute('fill') || '#f2f2f2'
  if (isBlob) {
    const fills = [...svg.querySelectorAll('[fill]')].map(n => n.getAttribute('fill')).filter(c => c && !/^(none|#fff|#ffffff|white|#000|#000000|black)$/i.test(c) && !/^url/.test(c))
    color = fills[0] || color
  }
  color = safeColor(color)
  return {
    shape: isBlob ? 'blob' : (svg.getAttribute('data-hb-shape') || 'circle'),
    color,
    mode: /work|think/.test(svg.getAttribute('data-hb-mood') || '') ? 'work' : 'idle',
    size: Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 36,
  }
}

function adopt(svg) {
  if (faces.has(svg) || svg.closest('[data-bloub-wrap]')) return
  const f = readFace(svg)
  const name = svg.getAttribute('data-bot-face')
  if (name && !known.has(name)) known.set(name, { shape: f.shape, color: f.color })
  const wrap = document.createElement('span')
  wrap.setAttribute('data-bloub-wrap', '')
  wrap.style.cssText = `display:inline-grid;place-items:center;width:${f.size}px;height:${f.size}px;line-height:0;flex-shrink:0`
  const target = svg.parentElement?.tagName === 'SPAN' && svg.parentElement.children.length === 1 && svg.parentElement.style.lineHeight === '0px' ? svg.parentElement : svg
  target.style.display = 'none'
  target.setAttribute('data-bloub-hidden', '')
  target.parentElement.insertBefore(wrap, target.nextSibling)
  const av = mount(wrap, { size: f.size, shape: f.shape, color: f.color, paper: PAPER, mode: f.mode })
  faces.set(svg, { av, wrap, target })
  live.add(svg)
}

const live = new Set()
function sync() {
  for (const svg of live) {
    const rec = faces.get(svg)
    if (!svg.isConnected) { rec?.av.destroy(); rec?.wrap.remove(); live.delete(svg); continue }
    const f = readFace(svg)
    rec.av.set({ shape: f.shape, color: f.color, mode: f.mode })
    const name = svg.getAttribute('data-bot-face')
    if (name) known.set(name, { ...(known.get(name) || {}), shape: f.shape, color: f.color })
  }
}

function scan() {
  document.querySelectorAll('svg[data-bot-face]:not([data-bloub])').forEach(adopt)
}

// ---- bot chat pill ----
let metaLoaded = false
async function loadMeta() {
  if (metaLoaded) return
  metaLoaded = true
  try {
    const r = await host.request('profiles.list', { include_sessions: false })
    for (const p of r?.profiles || []) {
      const m = p?.ui_meta?.['hermes-bots'] || {}
      const prev = known.get(p.name) || {}
      known.set(p.name, { shape: m.shape || prev.shape, color: safeColor(m.color, prev.color), title: m.title || p.name })
    }
  } catch {}
}
let pillAv = null
function renderPill() {
  const profile = host.state.focusedSessionProfile?.get?.() || null
  const thread = [...document.querySelectorAll('[data-slot="thread"]')].find(t => t.offsetParent)
  let pill = document.getElementById('bb-pill')
  const isBot = profile && profile !== 'default'
  if (!isBot || !thread) { pill?.remove(); pillAv = null; return }
  loadMeta()
  const k = { ...(known.get(profile) || {}), ...(profile === 'default' ? PRIMARY : {}) }
  const title = k.title || profile
  if (!pill || pill.parentElement !== thread) {
    pill?.remove()
    pill = document.createElement('div'); pill.id = 'bb-pill'
    // click → bot-panel plugin toggles the right-sidebar bot inspector
    pill.setAttribute('role', 'button'); pill.title = 'Bot settings'
    pill.style.pointerEvents = 'auto'; pill.style.cursor = 'pointer'
    let pd = 0
    pill.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); pd = Date.now(); window.dispatchEvent(new CustomEvent('bb:toggle-bot-panel')) })
    pill.addEventListener('click', e => { e.stopPropagation(); if (Date.now() - pd > 600) window.dispatchEvent(new CustomEvent('bb:toggle-bot-panel')) })
    const ic = document.createElement('span'); ic.className = 'bb-pill-ic'
    const tx = document.createElement('span'); tx.className = 'bb-pill-tx'
    pill.append(ic, tx); thread.appendChild(pill)
    pillAv = mount(ic, { size: 22, shape: k.shape || 'circle', color: k.color || '#f2f2f2', paper: PAPER, mode: 'idle' })
  }
  pill.querySelector('.bb-pill-tx').textContent = title
  const busy = host.state.busy?.get?.()
  pillAv?.set({ shape: k.shape || 'circle', color: k.color || '#f2f2f2', mode: busy ? 'work' : 'idle' })
}

// ---- sidebar mascot: Sessions <-> Bots ----
let mascot = null
function tabs() {
  const all = [...document.querySelectorAll('[data-tree-tab]')]
  return { sessions: all.find(t => t.getAttribute('aria-label') === 'Sessions'), bots: all.find(t => t.getAttribute('aria-label') === 'Bots') }
}
// Own collapse button inside the sidebar zone (absolute, so it never drifts);
// it triggers the native "Hide sidebar" button, which stays hidden.
let pctx = null
function nativeHide() { return document.querySelector('button[aria-label="Hide sidebar"]:not(#bb-collapse)') }
function fireNative(btn) {
  for (let f = fiberOf(btn); f; f = f.return) {
    const pr = f.memoizedProps
    if (f.stateNode === btn || (pr && typeof pr.onClick === 'function')) {
      if (pr && typeof pr.onClick === 'function') { pr.onClick({ currentTarget: btn, target: btn, preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); return }
    }
  }
  btn.click()
}
function placeCollapse() {
  document.getElementById('bb-collapse')?.remove()
  const zone = document.querySelector('[data-bb-left-zone]')
  if (zone) {
    zone.toggleAttribute('data-bb-collapsed', zone.getBoundingClientRect().width < 120)
    // let the sidebar shrink below the core 237px floor (the sash reads computed min-width)
    if (!zone.__bbNarrow) { zone.__bbNarrow = 1
      for (let el = zone, i = 0; el && i < 4; el = el.parentElement, i++) if (parseFloat(getComputedStyle(el).minWidth) >= 200) el.setAttribute('data-bb-narrow', '')
    }
  }
}
// Bots roster: right-click on empty space opens the native "+" menu at the cursor
function visibleAdd() {
  // Inactive tabs (Bots while in Sessions) stay mounted but inert/aria-hidden.
  for (const b of document.querySelectorAll('button[aria-label="New bot or group chat"]')) {
    if (!b.isConnected || b.closest('[inert], [aria-hidden="true"]')) continue
    const host = b.closest('[data-tree-group]')
    if (host) return { add: b, host }
  }
  return null
}
// Bots pane only: the visible "New bot" button marks Bot Mode (tab state is
// unreliable — the Sessions/Bots strip is hidden). Sessions keeps the shell menu.
function rosterTarget(t) {
  if (!(t instanceof Element)) return null
  if (t.closest('[data-roster-key], [data-slot="bots-section-heading"], #bb-hero, [role="menu"], input, textarea')) return null
  const v = visibleAdd()
  return v && v.host.contains(t) ? { add: v.add, zone: v.host } : null
}
// The shell's own window-capture contextmenu listener runs before ours, so
// mark the zone as skip on the right-button press that precedes it.
function rosterPress(e) {
  if (e.button !== 2) return
  document.querySelectorAll('[data-bb-skip]').forEach(n => { n.removeAttribute('data-bb-skip'); n.removeAttribute('data-context-menu-skip') })
  const r = rosterTarget(e.target)
  if (r && !r.zone.hasAttribute('data-context-menu-skip')) { r.zone.setAttribute('data-context-menu-skip', ''); r.zone.setAttribute('data-bb-skip', '') }
}
function rosterContextMenu(e) {
  const r = rosterTarget(e.target)
  if (!r) return
  const { add } = r
  e.preventDefault(); e.stopImmediatePropagation()
  add.setAttribute('data-bb-anchor', '')
  add.style.left = e.clientX + 'px'; add.style.top = e.clientY + 'px'
  add.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false }))
}
function renderMascot() {
  placeCollapse()
  const foot = document.getElementById('mf-footer')
  const { sessions, bots } = tabs()
  const hdr = bots?.closest('[data-panel-header]')
  if (hdr) { __set(hdr, 'data-bb-sidebar-tabs'); __set(hdr.parentElement, 'data-bb-left-zone') }
  if (!foot || !bots) return
  let btn = document.getElementById('bb-mascot')
  if (!btn || btn.parentElement !== foot) {
    btn?.remove()
    btn = document.createElement('button'); btn.id = 'bb-mascot'; btn.type = 'button'
    foot.insertBefore(btn, foot.querySelector('.mf-conn'))
    const face = document.createElement('span'); face.className = 'bb-face'; btn.appendChild(face)
    mascot = mount(face, { size: 18, shape: 'circle', color: '#f4f4f4', paper: PAPER, mode: 'idle' })
    const code = document.createElement('span'); code.className = 'bb-code'
    code.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/></svg>'
    btn.appendChild(code)
    const activate = tab => {
      if (!tab) return
      // Call the tab's own React onActivate (same path as Enter/click), then fall back to events.
      for (let f = fiberOf(tab); f; f = f.return) {
        const pr = f.memoizedProps
        if (pr && typeof pr.onActivate === 'function') { pr.onActivate(); return }
        if (pr && typeof pr.onClick === 'function' && f.stateNode === tab) { pr.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: tab, target: tab }); return }
      }
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    }
    const toggle = () => {
      const t = tabs()
      const inBots = t.bots?.getAttribute('aria-selected') === 'true'
      activate(inBots ? t.sessions : t.bots)
    }
    // pointerdown, not click: the sidebar re-renders often and a click needs the
    // same node under both mousedown and mouseup.
    let lastPd = 0
    btn.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); lastPd = Date.now(); toggle() })
    // Accessibility / keyboard-free activation sends click without pointerdown.
    btn.addEventListener('click', e => { e.stopPropagation(); if (Date.now() - lastPd > 600) toggle() })
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
  }
  const inBots = bots.getAttribute('aria-selected') === 'true'
  __set(btn, 'data-mode', inBots ? 'bots' : 'sessions')
  const lbl = inBots ? 'Back to coding sessions' : 'Switch to bots'
  __set(btn, 'title', lbl); __set(btn, 'aria-label', lbl)
}

// ---- bloub picker inside the New bot / Edit bot dialogs ----
const PICK_SHAPES = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']
const PICK_COLORS = ['#f4f4f4', '#a3a3a3', '#e8483f', '#f08a24', '#f0b429', '#3ecf8e', '#2fbfa0', '#3b93f0', '#8b5cf6', '#e152b0', '#8b5e3c', '#f1efe9']
const fiberOf = el => el && el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
function pickerProps(el) {
  for (let f = fiberOf(el); f; f = f.return) { const p = f.memoizedProps; if (p && typeof p.onShape === 'function' && typeof p.onColor === 'function') return p }
  return null
}
function findSeg(dlg) {
  return [...dlg.querySelectorAll('button, [role="radio"], [role="tab"]')].find(b => b.textContent.trim() === 'Bot' && b.isConnected)
}
function nativeRoot(seg) {
  // outermost .grid.justify-items-center that is still inside the dialog form
  let n = seg.closest('.grid.justify-items-center'), up
  while (n && (up = n.parentElement?.closest('.grid.justify-items-center')) && !up.querySelector('input, textarea')) n = up
  return n
}
function renderPicker() {
  for (const dlg of document.querySelectorAll('[role="dialog"]')) {
    const seg = findSeg(dlg)
    if (!seg) continue
    const props = pickerProps(seg)
    const native = nativeRoot(seg)
    if (!props || !native) continue
    __set(native, 'data-bb-native', dlg._bbShowNative ? 'shown' : 'hidden')
    const cur = () => { const sg = findSeg(dlg); return (sg && pickerProps(sg)) || props }
    let panel = dlg.querySelector('#bb-picker')
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'bb-picker'
      const shapes = document.createElement('div'); shapes.className = 'bb-shapes'
      const colors = document.createElement('div'); colors.className = 'bb-colors'
      const more = document.createElement('button'); more.type = 'button'; more.className = 'bb-more'; more.textContent = 'Use an image instead'
      panel.append(shapes, colors, more)
      native.parentElement.insertBefore(panel, native)
      more.onclick = () => { dlg._bbShowNative = !dlg._bbShowNative; more.textContent = dlg._bbShowNative ? 'Back to bloub shapes' : 'Use an image instead'; renderPicker() }
      panel._thumbs = []
      for (const sh of PICK_SHAPES) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bb-shape'; b.dataset.shape = sh; b.title = sh
        b.onclick = () => { const p = cur(); p.onImage?.(null); p.onShape(sh); if (!p.color) p.onColor(panel._color || PICK_COLORS[0]); setTimeout(renderPicker, 30) }
        shapes.appendChild(b)
        panel._thumbs.push(mount(b, { size: 30, shape: sh, color: '#f4f4f4', paper: PAPER, mode: 'idle' }))
      }
      for (const c of PICK_COLORS) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'bb-color'; b.dataset.color = c; b.style.background = c; b.title = c
        b.onclick = () => { panel._color = c; const p = cur(); p.onColor(c); if (!PICK_SHAPES.includes(p.shape)) p.onShape('circle'); setTimeout(renderPicker, 30) }
        colors.appendChild(b)
      }
    }
    const p = cur()
    const col = safeColor(p.color, panel._color || '#f4f4f4')
    panel._thumbs.forEach(t => t.set({ color: col }))
    panel.querySelectorAll('.bb-shape').forEach(b => b.toggleAttribute('data-on', b.dataset.shape === p.shape))
    panel.querySelectorAll('.bb-color').forEach(b => b.toggleAttribute('data-on', (p.color || '').toLowerCase() === b.dataset.color))
  }
}

// ---- Bots pane: primary bot as a big head on top, team listed below ----
let heroAv = null
function renderHero() {
  const row = document.querySelector('[data-roster-key$="::default"]')
  let hero = document.getElementById('bb-hero')
  if (!row || !visibleAdd()) document.querySelectorAll('[data-bb-zone-skip]').forEach(n => { n.removeAttribute('data-bb-zone-skip'); n.removeAttribute('data-context-menu-skip') })
  if (!row || !row.offsetParent && !row.hasAttribute('data-bb-hero-src')) { if (!row) { hero?.remove(); heroAv = null } ; if (!row) return }
  // the roster list = nearest scroll container above the row
  let list = row.parentElement
  while (list && list !== document.body && getComputedStyle(list).overflowY === 'visible') list = list.parentElement
  if (!list || list === document.body) return
  __set(row, 'data-bb-hero-src')
  // the shell's generic menu must not take blank right-clicks in the roster
  const vA = visibleAdd(), addB = vA?.add
  const z = vA?.host || list
  document.querySelectorAll('[data-bb-zone-skip]').forEach(n => { if (n !== z || !addB) { n.removeAttribute('data-bb-zone-skip'); n.removeAttribute('data-context-menu-skip') } })
  if (addB && !z.hasAttribute('data-context-menu-skip')) { z.setAttribute('data-context-menu-skip', ''); z.setAttribute('data-bb-zone-skip', '') }
  const name = row.querySelector('.truncate.font-medium')?.textContent?.trim() || 'Hermes'
  const nativeFace = row.querySelector('svg[data-bot-face="default"]')
  // Read the roster's committed appearance, never the unsaved editor preview.
  const { shape, color, mode } = nativeFace ? readFace(nativeFace) : PRIMARY
  if (!hero || hero.parentElement !== list || list.firstElementChild !== hero) {
    hero?.remove()
    hero = document.createElement('button'); hero.id = 'bb-hero'; hero.type = 'button'
    const face = document.createElement('span'); face.className = 'bb-hero-face'
    const nm = document.createElement('span'); nm.className = 'bb-hero-name'
    hero.append(face, nm)
    list.insertBefore(hero, list.firstChild)
    heroAv = mount(face, { size: 76, shape, color, paper: PAPER, mode: mode || 'idle' })
    hero.addEventListener('click', () => document.querySelector('[data-roster-key$="::default"]')?.click())
    hero.addEventListener('contextmenu', e => { e.preventDefault(); const r = document.querySelector('[data-roster-key$="::default"]'); r?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })) })
  }
  const hn = hero.querySelector('.bb-hero-name'); if (hn.textContent !== name) hn.textContent = name
  const act = row.className.includes('row-active'); if (hero.hasAttribute('data-active') !== act) hero.toggleAttribute('data-active', act)
  heroAv?.set({ shape, color, mode: mode || 'idle' })
  // header: tag it for styling
  const add = [...document.querySelectorAll('button[aria-label="New bot or group chat"]')].find(b => b.offsetParent)
  __set(add?.parentElement?.parentElement, 'data-bb-roster-head')
}

export default {
  id: 'bloub-bots',
  name: 'Bloub Bots',
  register(ctx) {
    pctx = ctx
    window.addEventListener('contextmenu', rosterContextMenu, true)
    window.addEventListener('pointerdown', rosterPress, true)
    const run = () => { try { scan(); renderMascot(); renderPill(); renderPicker(); renderHero(); placeCollapse() } catch (e) { console.warn('bloub-bots', e) } }
    const runT = __throttle(run, 150)
    const mo = new MutationObserver(recs => { if (__relevant(recs)) runT() })
    mo.observe(document.body, { childList: true, subtree: true })
    const iv = setInterval(() => { if (document.hidden) return; sync(); renderPill(); placeCollapse(); renderHero() }, 1500)
    run()
    ctx.onDispose(() => {
      mo.disconnect(); clearInterval(iv)
      for (const svg of live) { const r = faces.get(svg); r?.av.destroy(); r?.wrap.remove(); if (r?.target) r.target.style.display = '' }
      live.clear()
      document.getElementById('bb-pill')?.remove(); document.getElementById('bb-mascot')?.remove(); document.getElementById('bb-hero')?.remove()
      window.removeEventListener('contextmenu', rosterContextMenu, true); window.removeEventListener('pointerdown', rosterPress, true); document.querySelectorAll('[data-bb-narrow]').forEach(n => n.removeAttribute('data-bb-narrow'))
      document.querySelectorAll('[data-bb-sidebar-tabs]').forEach(n => n.removeAttribute('data-bb-sidebar-tabs'))
    })
  }
}

const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const dropzone = $("dropzone");
const convertButton = $("convertButton");
let selectedFile = null;
let midiBlob = null;

fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
$("removeFile").addEventListener("click", clearFile);
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault(); dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});
convertButton.addEventListener("click", convert);
$("downloadButton").addEventListener("click", downloadMidi);

function setFile(file) {
  if (!file) return;
  if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name)) {
    showError("Choose an audio file to continue."); return;
  }
  selectedFile = file;
  $("filePrompt").textContent = "Audio selected";
  $("fileRow").classList.remove("hidden");
  $("fileName").textContent = file.name;
  $("fileDetails").textContent = formatBytes(file.size);
  $("result").classList.add("hidden");
  $("errorMessage").classList.add("hidden");
  convertButton.disabled = false;
}
function clearFile() {
  selectedFile = null; fileInput.value = "";
  $("filePrompt").textContent = "Drop an audio file here";
  $("fileRow").classList.add("hidden");
  $("result").classList.add("hidden");
  convertButton.disabled = true;
}
function formatBytes(n) { return n < 1048576 ? (n/1024).toFixed(0)+" KB" : (n/1048576).toFixed(1)+" MB"; }
function showError(message) { $("errorMessage").textContent = message; $("errorMessage").classList.remove("hidden"); }
function setProgress(percent, message) {
  $("progressWrap").classList.remove("hidden");
  $("progressBar").style.width = percent + "%";
  $("progressPercent").textContent = Math.round(percent) + "%";
  $("statusText").textContent = message;
}

async function convert() {
  if (!selectedFile) return;
  convertButton.disabled = true;
  $("result").classList.add("hidden");
  $("errorMessage").classList.add("hidden");
  midiBlob = null;
  let audioContext;
  try {
    setProgress(2, "Decoding audio…");
    const bytes = await selectedFile.arrayBuffer();
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await audioContext.decodeAudioData(bytes);
    if (audio.duration > 300) throw new Error("For this first version, audio is limited to 5 minutes.");
    const mono = mixToMono(audio);
    const fftSize = Number($("resolution").value);
    const maxPeaks = Number($("density").value);
    const events = await analyze(mono, audio.sampleRate, fftSize, maxPeaks);
    if (!events.length) throw new Error("No stable frequency peaks were detected. Try a different audio file or analysis setting.");
    setProgress(94, "Writing MIDI events…");
    const midi = buildMidi(events);
    midiBlob = new Blob([midi], {type:"audio/midi"});
    $("resultDetails").textContent = events.length.toLocaleString()+" note events · "+audio.duration.toFixed(1)+" seconds analyzed";
    $("result").classList.remove("hidden");
    setProgress(100, "Conversion complete");
  } catch (error) {
    showError(error.message || "Conversion failed. Try another audio file.");
    $("progressWrap").classList.add("hidden");
  } finally {
    if (audioContext) await audioContext.close();
    convertButton.disabled = !selectedFile;
  }
}

function mixToMono(audio) {
  const length = audio.length;
  const mono = new Float32Array(length);
  const channels = audio.numberOfChannels;
  for (let c=0;c<channels;c++) {
    const data = audio.getChannelData(c);
    for (let i=0;i<length;i++) mono[i] += data[i] / channels;
  }
  return mono;
}

// In-place radix-2 FFT. The spectrum is used as a pitch-component estimate,
// not as a literal conversion of individual PCM samples into musical notes.
function fft(real, imag) {
  const n = real.length;
  for (let i=1,j=0;i<n;i++) {
    let bit=n>>1;
    for (;j&bit;bit>>=1) j^=bit;
    j^=bit;
    if (i<j) {
      const tempReal=real[i]; real[i]=real[j]; real[j]=tempReal;
      const tempImag=imag[i]; imag[i]=imag[j]; imag[j]=tempImag;
    }
  }
  for (let len=2;len<=n;len<<=1) {
    const angle=-2*Math.PI/len, wr0=Math.cos(angle), wi0=Math.sin(angle);
    for (let i=0;i<n;i+=len) {
      let wr=1,wi=0;
      for (let j=0;j<len/2;j++) {
        const u=i+j,v=i+j+len/2;
        const tr=real[v]*wr-imag[v]*wi, ti=real[v]*wi+imag[v]*wr;
        real[v]=real[u]-tr; imag[v]=imag[u]-ti;
        real[u]+=tr; imag[u]+=ti;
        const nextWr=wr*wr0-wi*wi0;
        wi=wr*wi0+wi*wr0; wr=nextWr;
      }
    }
  }
}

async function analyze(samples, sampleRate, fftSize, maxPeaks) {
  const hop = Math.max(128, Math.floor(fftSize/16));
  const half = fftSize/2;
  const window = new Float32Array(fftSize);
  for (let i=0;i<fftSize;i++) window[i]=0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));
  const real=new Float32Array(fftSize), imag=new Float32Array(fftSize);
  const active=new Map(), events=[];
  const totalFrames=Math.max(1,Math.ceil(Math.max(0,samples.length-fftSize)/hop)+1);
  const minHz=40,maxHz=4000;
  for (let frame=0;frame<totalFrames;frame++) {
    const offset=frame*hop;
    let energy=0;
    for(let i=0;i<fftSize;i++) {
      const value=(samples[offset+i]||0)*window[i];
      real[i]=value; imag[i]=0; energy+=value*value;
    }
    if (energy>1e-9) {
      fft(real,imag);
      const mags=new Float32Array(half);
      let maxMag=0;
      for(let k=1;k<half;k++) {
        const mag=Math.hypot(real[k],imag[k]);
        mags[k]=mag;
        if(mag>maxMag) maxMag=mag;
      }
      const candidates=[];
      const threshold=maxMag*0.025;
      const lowBin=Math.max(2,Math.floor(minHz*fftSize/sampleRate));
      const highBin=Math.min(half-2,Math.ceil(maxHz*fftSize/sampleRate));
      for(let k=lowBin;k<=highBin;k++) {
        if(mags[k]>threshold && mags[k]>=mags[k-1] && mags[k]>mags[k+1]) {
          const a=Math.log(mags[k-1]+1e-12), b=Math.log(mags[k]+1e-12), c=Math.log(mags[k+1]+1e-12);
          const denom=a-2*b+c;
          const shift=denom===0?0:Math.max(-0.5,Math.min(0.5,0.5*(a-c)/denom));
          const hz=(k+shift)*sampleRate/fftSize;
          const note=Math.round(69+12*Math.log2(hz/440));
          candidates.push({note, strength:mags[k]/maxMag});
        }
      }
      candidates.sort((a,b)=>b.strength-a.strength);
      const seen=new Set();
      for(const peak of candidates) {
        if(seen.has(peak.note)) continue;
        seen.add(peak.note);
        const key=peak.note;
        const current=active.get(key);
        if(current) { current.last=frame; current.velocity=Math.max(current.velocity,Math.min(120,Math.round(48+peak.strength*72))); }
        else active.set(key,{start:frame,last:frame,velocity:Math.min(120,Math.round(48+peak.strength*72))});
        if(seen.size>=maxPeaks) break;
      }
    }
    for(const [note,state] of active) {
      if(frame-state.last>1) {
        const start=state.start*hop/sampleRate;
        const end=Math.max(start+hop/sampleRate,(state.last+1)*hop/sampleRate);
        events.push({note,start,end,velocity:state.velocity});
        active.delete(note);
      }
    }
    if(frame%24===0) {
      setProgress(5+(frame/totalFrames)*84,"Analyzing spectrum · frame "+frame.toLocaleString()+" / "+totalFrames.toLocaleString());
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  for(const [note,state] of active) {
    const start=state.start*hop/sampleRate;
    const end=Math.max(start+hop/sampleRate,(state.last+1)*hop/sampleRate);
    events.push({note,start,end,velocity:state.velocity});
  }
  events.sort((a,b)=>a.start-b.start || a.note-b.note);
  return events;
}

function vlq(value) {
  let buffer=value&0x7f, out=[];
  while((value>>=7)>0) { buffer<<=8; buffer|=((value&0x7f)|0x80); }
  while(true) { out.push(buffer&255); if(buffer&0x80) buffer>>=8; else break; }
  return out;
}
function pushAscii(out,text) { for(const c of text) out.push(c.charCodeAt(0)); }
function buildMidi(events) {
  const ppq=480, tempo=500000, track=[];
  const ticksPerSecond=ppq*1000000/tempo;
  const messages=[];
  for(const event of events) {
    const start=Math.max(0,Math.round(event.start*ticksPerSecond));
    const end=Math.max(start+1,Math.round(event.end*ticksPerSecond));
    messages.push({tick:start,priority:1,data:[0x90,event.note,Math.max(1,Math.min(127,event.velocity))]});
    messages.push({tick:end,priority:0,data:[0x80,event.note,0]});
  }
  messages.sort((a,b)=>a.tick-b.tick || a.priority-b.priority);
  // Set tempo to 120 BPM.
  track.push(0x00,0xff,0x51,0x03,(tempo>>16)&255,(tempo>>8)&255,tempo&255);
  let previous=0;
  for(const msg of messages) {
    const deltaBytes=vlq(msg.tick-previous);
    for(let i=0;i<deltaBytes.length;i++) track.push(deltaBytes[i]);
    track.push(msg.data[0],msg.data[1],msg.data[2]);
    previous=msg.tick;
  }
  track.push(0x00,0xff,0x2f,0x00);
  const out=[];
  pushAscii(out,"MThd"); out.push(0,0,0,6,0,0,0,1,(ppq>>8)&255,ppq&255);
  pushAscii(out,"MTrk");
  const n=track.length;
  out.push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);
  // Avoid spreading a potentially huge note track into one function call.
  // Dense conversions can contain hundreds of thousands of MIDI bytes.
  for (let i=0;i<track.length;i++) out.push(track[i]);
  return new Uint8Array(out);
}
function downloadMidi() {
  if(!midiBlob) return;
  const url=URL.createObjectURL(midiBlob);
  const a=document.createElement("a");
  a.href=url;
  a.download=(selectedFile?.name.replace(/\.[^.]+$/,"")||"audio")+".mid";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

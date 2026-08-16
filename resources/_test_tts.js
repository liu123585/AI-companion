const { synthesize } = require('D:/桌面/vibe coding/AICompanion/resources/app/tts-local');
const fs = require('fs');
const os = require('os');
(async () => {
  try {
    const r = await synthesize('你好，我是你的AI伴侣，今天过得开心吗？', null, 'girl', 'happy');
    if (r && r.buf && r.buf.length > 44) {
      const p = os.tmpdir() + '/test_out.wav';
      fs.writeFileSync(p, r.buf);
      console.log('SYNTH-OK bytes=' + r.buf.length + ' path=' + p);
    } else { console.log('SYNTH-EMPTY'); }
  } catch (e) { console.log('SYNTH-ERR ' + e.message); }
})();

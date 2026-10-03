/**
 * Audio board: runs renderForCheck() (every SFX + music loop, offline 48 kHz),
 * exposes window.__audioResults, and draws every spectrogram with its numeric
 * stats (green = pass, red = fail per threshold). Pending owner review.
 */
import type { LabContext } from '../context';
import { palette } from '../../style/tokens';
import { withAlpha } from '../../style/color';
import { AUDIO_TARGETS, checkMixer, rampColour, renderForCheck, type AudioCheckResult } from '../../gen/audio/offline';
import { MUSIC_BPM, MUSIC_KEY, LOOP_BARS } from '../../gen/audio/music';

async function loadImg(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export default async function board(ctx: LabContext) {
  const g = ctx.overlay;
  ctx.clearAll(palette.spaceDeep);
  const t0 = performance.now();
  const M = 12, top = 64, colW = 1372, musicX = M + colW + M;
  const cols = 5, rows = 4, gap = 10;
  const cw = (colW - gap * (cols - 1)) / cols;
  const chh = (1080 - top - M - gap * (rows - 1)) / rows;
  const specH = Math.round(chh - 58);
  const mw = 1920 - musicX - M;
  const mh = 176, mSpecH = mh - 40;

  const results = await renderForCheck({ sfxSize: [Math.round(cw), specH], musicSize: [Math.round(mw), mSpecH] });
  (window as unknown as { __audioResults: AudioCheckResult[] }).__audioResults = results;
  const mix = await checkMixer();
  const totalMs = Math.round(performance.now() - t0);
  const passN = results.filter((r) => r.pass).length;
  ctx.title('Audio check: offline renders + spectrograms', `${passN}/${results.length} pass · ${MUSIC_KEY} ${MUSIC_BPM} BPM ${LOOP_BARS} bars · pending owner review (not audible to the agent)`);

  const ok = palette.hudText, bad = palette.shieldRed, lab = palette.hudValue;
  const T = AUDIO_TARGETS;
  const text = (parts: [string, string][], x: number, y: number) => {
    let cx = x;
    for (const [s, c] of parts) {
      g.fillStyle = c;
      g.fillText(s, cx, y);
      cx += g.measureText(s).width;
    }
  };
  g.font = '13px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'top';

  const sfx = results.filter((r) => r.kind === 'sfx');
  for (let i = 0; i < sfx.length; i++) {
    const r = sfx[i];
    const x = M + (i % cols) * (cw + gap), y = top + Math.floor(i / cols) * (chh + gap);
    g.fillStyle = withAlpha(palette.hudDim, 0.35);
    g.fillRect(x - 2, y - 2, cw + 4, chh + 4);
    g.drawImage(await loadImg(r.spectrogramPng), x, y, cw, specH);
    g.strokeStyle = r.pass ? palette.hudLine : bad;
    g.lineWidth = 2;
    g.strokeRect(x - 1, y - 1, cw + 2, chh + 2);
    const pk = r.peakDbfs <= T.peakMaxDbfs, rm = r.rmsDbfs >= T.sfxRms[0] && r.rmsDbfs <= T.sfxRms[1];
    const dc = Math.abs(r.dcOffset) < T.dcMax;
    text([['pk ', lab], [r.peakDbfs.toFixed(1), pk ? ok : bad], ['  rms ', lab], [r.rmsDbfs.toFixed(1), rm ? ok : bad], [' dBFS', lab]], x + 4, y + specH + 6);
    text([['dc ', lab], [r.dcOffset.toExponential(1), dc ? ok : bad], ['  clip ', lab], [r.clipping ? 'YES' : 'no', r.clipping ? bad : ok], [`  act ${(r.activeS ?? 0).toFixed(2)}s`, lab]], x + 4, y + specH + 24);
  }

  const music = results.filter((r) => r.kind === 'music');
  for (let i = 0; i < music.length; i++) {
    const r = music[i];
    const x = musicX, y = top + i * (mh + 6);
    g.fillStyle = withAlpha(palette.hudDim, 0.35);
    g.fillRect(x - 2, y - 2, mw + 4, mh + 4);
    g.drawImage(await loadImg(r.spectrogramPng), x, y, mw, mSpecH);
    g.strokeStyle = r.pass ? palette.hudLine : bad;
    g.lineWidth = 2;
    g.strokeRect(x - 1, y - 1, mw + 2, mh + 2);
    const pk = r.peakDbfs <= T.peakMaxDbfs;
    const rTarget = r.intensity === T.musicRmsAtIntensity;
    const rm = !rTarget || (r.rmsDbfs >= T.musicRms[0] && r.rmsDbfs <= T.musicRms[1]);
    text([['pk ', lab], [r.peakDbfs.toFixed(1), pk ? ok : bad], ['  rms ', lab], [r.rmsDbfs.toFixed(1), rTarget ? (rm ? ok : bad) : lab], [rTarget ? ' (target)' : '', lab], ['  dc ', lab], [r.dcOffset.toExponential(1), Math.abs(r.dcOffset) < T.dcMax ? ok : bad], ['  clip ', lab], [r.clipping ? 'YES' : 'no', r.clipping ? bad : ok]], x + 4, y + mSpecH + 4);
    text([['seam dRMS ', lab], [`${(r.seamDeltaDb ?? 0).toFixed(2)} dB`, (r.seamDeltaDb ?? 99) <= T.seamDbMax ? ok : bad], ['  jump ', lab], [(r.seamJump ?? 0).toFixed(3), (r.seamJump ?? 1) <= T.seamJumpMax ? ok : bad], ['  seam ', lab], [r.loopSeamOk ? 'OK' : 'FAIL', r.loopSeamOk ? ok : bad]], x + 4, y + mSpecH + 21);
  }

  // legend + mixer checks
  const ly = top + music.length * (mh + 6) + 4;
  const lw = mw;
  for (let i = 0; i < lw; i++) {
    g.fillStyle = rampColour(i / (lw - 1));
    g.fillRect(musicX + i, ly, 1, 10);
  }
  g.fillStyle = lab;
  text([['-100 dB', lab]], musicX, ly + 13);
  g.textAlign = 'right';
  g.fillText('-12 dB sfx / 0 dB music (STFT bin, 1024 Hann, hop 256)', musicX + lw, ly + 13);
  g.textAlign = 'left';
  const duckOk = Math.abs(mix.duckMeasuredDb - mix.duckTargetDb) < 2;
  const pileOk = mix.cannonHeldPeakDbfs <= Math.min(-1, mix.cannonSinglePeakDbfs + 3);
  const vs = mix.voiceStress;
  text([['duck test: target ', lab], [`${mix.duckTargetDb} dB`, lab], [' measured ', lab], [`${mix.duckMeasuredDb.toFixed(1)} dB`, duckOk ? ok : bad]], musicX, ly + 32);
  text([['cannon 2 s @14/s: pk ', lab], [`${mix.cannonHeldPeakDbfs.toFixed(1)}`, pileOk ? ok : bad], [` (single ${mix.cannonSinglePeakDbfs.toFixed(1)}) rms ${mix.cannonHeldRmsDbfs.toFixed(1)}`, lab]], musicX, ly + 49);
  text([[`voice stress 24x explosionSmall/0.2 s: played ${vs.played} dropped ${vs.dropped} stolen ${vs.stolen} max active `, lab], [`${vs.maxActive}/${vs.maxVoices}`, vs.maxActive <= vs.maxVoices ? ok : bad]], musicX, ly + 66);
  text([[`total render+analysis ${(totalMs / 1000).toFixed(1)} s · y: 30 Hz-16 kHz log`, lab]], musicX, ly + 83);

  ctx.exportParams({
    board: 'audio',
    status: 'implemented, agent-verified numerically, pending owner review (not audible to the agent)',
    totalMs,
    targets: AUDIO_TARGETS,
    mixer: mix,
    results: results.map(({ spectrogramPng, ...rest }) => rest),
  });
  ctx.ready();
}

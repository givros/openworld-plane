import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attitudeTransform } from '../src/systems/FlightHud.ts';

test('chase horizon keeps direct left and right bank signs, even at the clamp',()=>{
  for(const degrees of [-120,-50,-22,0,22,50,120]) {
    assert.ok(Math.abs(attitudeTransform(0,degrees*Math.PI/180).bank-Math.max(-50,Math.min(50,degrees)))<1e-10);
  }
});
test('nose-up pitch moves the horizon down and nose-down pitch moves it up',()=>{
  assert.ok(attitudeTransform(.12,0).pitch>0);
  assert.ok(attitudeTransform(-.12,0).pitch<0);
  assert.equal(attitudeTransform(2,0).pitch,26);
  assert.equal(attitudeTransform(-2,0).pitch,-26);
});
test('rendered attitude applies translation then a direct CSS bank rotation',()=>{
  const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
  assert.match(css,/transform:\s*translateY\(var\(--attitude-pitch\)\)\s+rotate\(var\(--attitude-bank\)\)/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const play = require('../electron/play');

test('pickLatest takes the highest live version code and ignores halted or draft releases', () => {
  const track = {
    track: 'production',
    releases: [
      { name: '1.5.0', status: 'draft', versionCodes: ['99'] },
      { name: '1.4.5', status: 'halted', versionCodes: ['95'] },
      { name: '1.4.4', status: 'inProgress', versionCodes: ['93'] },
      { name: '1.4.2', status: 'completed', versionCodes: ['91', '90'] },
    ],
  };
  assert.deepEqual(play.pickLatest(track), { versionCode: 93, versionName: '1.4.4', status: 'inProgress' });
  assert.equal(play.pickLatest({ releases: [] }), null);
  assert.equal(play.pickLatest(null), null);
});

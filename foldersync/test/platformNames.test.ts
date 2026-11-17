import {describe, expect, it} from 'vitest';

import {platformNames} from '../src/shared/platformNames';

describe('platformNames', () => {
  it('names Finder and the Mac on macOS', () => {
    expect(platformNames('darwin')).toEqual({
      showInFileManager: 'Show in Finder',
      removeFromComputer: 'Remove from This Mac',
      thisComputer: 'this Mac',
    });
  });

  it('names File Explorer and the PC on Windows', () => {
    expect(platformNames('win32')).toEqual({
      showInFileManager: 'Show in File Explorer',
      removeFromComputer: 'Remove from This PC',
      thisComputer: 'this PC',
    });
  });

  it('uses general names on Linux', () => {
    expect(platformNames('linux')).toEqual({
      showInFileManager: 'Show in File Manager',
      removeFromComputer: 'Remove from This Computer',
      thisComputer: 'this computer',
    });
  });
});

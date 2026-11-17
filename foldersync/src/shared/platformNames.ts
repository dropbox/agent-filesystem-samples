// What each platform calls its file manager and the computer, for the window
// and its menus.
export interface PlatformNames {
  // Opens a project folder or a file's folder in the file manager.
  showInFileManager: string;
  // Stops syncing a project here.
  removeFromComputer: string;
  // The computer in a sentence, like "Stop syncing it on this Mac?"
  thisComputer: string;
}

export function platformNames(platform: string): PlatformNames {
  switch (platform) {
    case 'darwin':
      return {
        showInFileManager: 'Show in Finder',
        removeFromComputer: 'Remove from This Mac',
        thisComputer: 'this Mac',
      };
    case 'win32':
      return {
        showInFileManager: 'Show in File Explorer',
        removeFromComputer: 'Remove from This PC',
        thisComputer: 'this PC',
      };
    default:
      return {
        showInFileManager: 'Show in File Manager',
        removeFromComputer: 'Remove from This Computer',
        thisComputer: 'this computer',
      };
  }
}

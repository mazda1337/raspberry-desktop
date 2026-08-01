import Store from 'electron-store';

/** Single shared electron-store instance for the whole app.
 *  Multiple Store() instances cache separately and overwrite each other's keys. */
export const appStore = new Store({});

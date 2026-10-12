// Set at build time from package.json. Tests see the fallback.
declare const __PACKAGE_VERSION__: string | undefined;

export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined" ? __PACKAGE_VERSION__ : "0.0.0-test";

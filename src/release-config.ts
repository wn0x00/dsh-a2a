// The release build replaces the compiled module with its validated public origin.
// Source builds and local releases keep the local development gateway.
export const DEFAULT_GATEWAY: string = 'http://127.0.0.1:8000'
// The build writes the package version beside the selected public origin.
export const PLUGIN_VERSION: string = '0.0.0'

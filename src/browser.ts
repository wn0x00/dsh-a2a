import { spawn } from 'node:child_process'

/** Open a URL using the host operating system's default browser. */
export function openAuthorizationUrl(url: string): void {
  // Do not route Windows URLs through `cmd /c start`: the query string has
  // ampersands, which cmd can interpret as command separators. Explorer can
  // also treat an http URL as a filesystem location on some Windows setups.
  // rundll32 delegates directly to the user's registered URL handler and
  // receives the complete URL as one argv item.
  const command = process.platform === 'win32'
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\rundll32.exe`
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.once('error', () => {
    console.log(`Open this URL in a browser:\n${url}`)
  })
  child.unref()
  // Always print a copyable URL. This is useful when the Harness process has no
  // GUI or when the browser is running on another Windows desktop.
  console.log(`OAuth authorization URL:\n${url}`)
}

import { spawn } from 'node:child_process'

/** Open a URL using the host operating system's default browser. */
export async function openAuthorizationUrl(url: string, spawnBrowser: typeof spawn = spawn): Promise<void> {
  // Do not route Windows URLs through `cmd /c start`: the query string has
  // ampersands, which cmd can interpret as command separators. Explorer can
  // also treat an http URL as a filesystem location on some Windows setups.
  // rundll32 delegates directly to the user's registered URL handler and
  // receives the complete URL as one argv item.
  const command = process.platform === 'win32'
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\rundll32.exe`
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawnBrowser(command, args, { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    // Some handlers stay alive with the browser. A launched process is only
    // an authorization attempt; the settings page still waits for callback.
    const timer = setTimeout(resolve, 1500)
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('The system browser could not be opened'))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('The system browser could not be opened'))
    })
    child.unref()
  })
}

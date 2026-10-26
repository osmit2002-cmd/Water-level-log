/** Save a file: iOS share sheet ("Save to Files") when supported, otherwise a download link. */
export async function saveFile(text: string, filename: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
    // NotAllowedError etc.: fall through to download
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

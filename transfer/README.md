# Getting audiobooks from the PC onto the phone

Two scripts. The first is optional but makes everything else much faster.

## Step 1 (optional but worth it): merge the book into one file

Right-click **`Merge to One File.ps1`** and choose "Run with PowerShell". It asks for the folder holding the book, then where to save the result.

It turns a folder of chapter files into a single `.m4b` with chapter marks built in, named from the original filenames with leading track numbers stripped. Files are sorted naturally, so `2` comes before `10`.

Why this matters on iPhone: moving 40 chapter files means 40 downloads and 40 "Save to Files" taps. One merged file is one download, one save, one import. The Pattern reads the chapter marks back out, so you still get the full chapter list and per-chapter resume.

It also re-encodes to mono 64kbps AAC, which is transparent for narration and usually shrinks the book several times over, so there is less to transfer.

From a terminal instead:

```powershell
.\"Merge to One File.ps1" -Folder "D:\Audiobooks\The Eye of the World" -Out "D:\ToSend"
```

Skip this step if the book is already a single `.m4b` or `.mp3`.

## Step 2: beam it over Wi-Fi

Right-click **`Send to Phone.ps1`** and choose "Run with PowerShell". Pick the folder holding the file, and it prints a URL like:

```
http://192.168.2.13:8200
```

Open that in Chrome on your iPhone. You get a list of the audio files with sizes. Tap one to download it.

Both devices need to be on the same Wi-Fi. The first run may pop a Windows Firewall prompt: tick **Private networks** and allow it. Press Ctrl+C in the terminal when you are done; nothing is left running.

This is a direct transfer over your own network, so it moves at Wi-Fi speed. Nothing goes to the cloud and no account is involved.

## Step 3: save it where the app can reach it

In Chrome, after the download finishes, use **Save to Files** and put it in **On My iPhone**.

Choosing On My iPhone rather than iCloud Drive matters for a big book: iCloud Drive would upload the whole file back out to Apple and then pull it down again, which is slow and eats your iCloud storage. On My iPhone keeps it local.

## Step 4: import

Open The Pattern, tap the Wheel, and choose the file. You can select several files at once if you skipped the merge step.

---

## One thing to know about Chrome on iPhone

The player itself works fine in Chrome. Every browser on iOS is required to use Apple's WebKit engine underneath, so audio format support, storage, and the built-in converter all behave exactly as they would in Safari.

The difference is installing it. "Add to Home Screen" as a real standalone app is a Safari-only feature on iOS; Chrome can make a shortcut, but it opens back inside Chrome. That also means the library does not get the protected, persistent storage that an installed home-screen web app gets, so iOS is more willing to clear it if the phone runs very low on space or the app goes unused for a long stretch.

In practice, using it regularly keeps it alive. But keep the original files on the PC rather than treating the phone as the only copy. If the library ever does get cleared, the two scripts here make putting it back quick.

## Files

| File | Purpose |
| --- | --- |
| `Merge to One File.ps1` | Combines a folder of chapter files into one `.m4b` with chapter marks |
| `Send to Phone.ps1` | Finds your Wi-Fi address and starts the transfer server |
| `beam-server.js` | The server itself: file listing, forced downloads, resumable transfers |

`Merge to One File.ps1` uses ffmpeg from `Claude Apps\_tools\ffmpeg`. `Send to Phone.ps1` uses Node from `Claude Apps\_tools\node`. Both are already in place.

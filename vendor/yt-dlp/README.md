# yt-dlp runtime binaries

Place the official, executable binary for each release target here before
building an installer. These binaries are bundled with the app; they are not
copied into the user's data directory and do not contain user data.

```text
vendor/yt-dlp/darwin-arm64/yt-dlp
vendor/yt-dlp/darwin-x64/yt-dlp
vendor/yt-dlp/win32-x64/yt-dlp.exe
vendor/yt-dlp/linux-x64/yt-dlp
```

Use the current official release and verify its checksum before committing or
feeding it into CI. The release build fails rather than producing an installer
without this dependency.

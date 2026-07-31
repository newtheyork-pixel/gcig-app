# File Provider extension — blocked on a provisioning profile

The cloud glyph in Finder's Locations is drawn for File Provider domains
and for nothing else. A disk image gets the grey disk whatever icon it
carries: measured by comparing what `NSWorkspace.icon(forFile:)` resolves
for our volume against Macintosh HD — they differ, so the custom icon IS
installed and the sidebar simply does not use it.

So the icon needs this extension. The code here builds and conforms. What
it cannot do is load.

## What was tried, and what happened

Every attempt ends at `NSFileProviderManager.add(domain:)` with
`NSFileProviderErrorDomain -2001` (underlying -2014), "The application
cannot be used right now", and `pluginkit -m` never lists the extension.

| Signed as | Location | Result |
|---|---|---|
| ad-hoc (`-`) | build dir | not registered, -2001 |
| ad-hoc (`-`) | /Applications | not registered, -2001 |
| Developer ID | /Applications | not registered, -2001 |
| Developer ID + App Group entitlement | /Applications | not registered, -2001 |

The last row is the informative one. The entitlement is present in the
signature and the system still refuses, because an App Group entitlement
means nothing without a provisioning profile that authorises it for the
team. codesign will happily write an entitlement nobody granted.

## What would unblock it

1. An Xcode that launches on this macOS. The installed one does not; only
   `xcodebuild` works, so the Accounts pane is unreachable.
2. An Apple ID on team PW2VT56789 signed into it.
3. An App ID for `org.thegriffinfund.terminal` with App Groups enabled,
   and a group such as `PW2VT56789.org.thegriffinfund.terminal`.
4. A Developer ID provisioning profile carrying that capability,
   embedded at `Contents/embedded.provisionprofile`.

Then this extension is the presentation layer over `GriffinDrive`, which
already does the syncing, and it brings download-on-demand with it: the
thing the disk image cannot do, where a file exists as a placeholder
until somebody opens it.

Until then the volume works and looks like a disk. That is the whole of
the difference.

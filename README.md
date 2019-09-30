# uptobox-sync

An app to launch an upload (for now) of all files in a directory to uptobox keeping folders tree.
The uploaded files are set to private.

To use this app :

1. Requirement, `Unix plateform`, `yarn`, `NodeJS` (10+)
2. Clone this repository
3. Adjust your config by creating a config file in `~/.config/uptobox-sync.json` :
```json
{
  "application": {
    "mongo": {
      "url": "mongodb://127.0.0.1:27017/uptobox-sync" // feel free to add auth or other host here
    },
    "files": {
      "directories": [
        {
          "path": "/home/you/myfiles/photos", // the local directory to upload
          "remotePrefix": "/photos" // where to upload it in uptobox
        }
      ],
      "minSizeMegaBytes": 1 // minimum file size to upload, 1 is the minimum for ftp
    },
    "uptobox": {
      "preferredUploadType": "ftp", // how to upload files by default, ftp or http
      "token": "--API Token --", // can be found in https://uptobox.com/my_account
      "concurrencyLimit": 2, // number of files to upload at the same time
      "poolSize": 10,
      "ftp": {
        "waitTimeoutInSec": 600, // max time gave to uptobox to treat the uploaded ftp file
        "auth": {
          "user": "--uptobox username--",
          "password": "-- uptobox password --"
        }
      },
      "http": { // in beta
        "sessionId": "-- session id found in xhr when you upload a file via web site --",
        "url": "-- uptobox url found in xhr when you upload a file via web site --"
      }
    }
  }
}
```
4. Launch `yarn build` in it
5. Launch `node dist/`
6. Check the app lauched successfully, check the config printed
7. Call `POST http://localhost:6686/files/refresh` to refresh files index
8. Call `POST http://localhost:6686/sync` to start syncing
9. Check upload going greats
    1. files with error get a property `error` in DB and will be ignored at the next launch
    2. Files uploaded great get a property `syncDate` in DB and will be ignored at the next launch


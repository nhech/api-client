# API Client: Import from Thunder Client (draft)

Imports Thunder Client collections and environments into plain `.http` files.

- Run **API Client: Import from Thunder Client...** from the Command Palette. Nothing runs by itself.
- It reads the data folder you choose (or export files), shows a report, and writes the files only after you confirm.
- Secrets go to `http-client.private.env.json`, which is added to `.gitignore`.
- Local only: no account, no network, no telemetry.

This is a draft build of the importer; the product name is not decided. Source and documentation: https://github.com/nhech/api-client. MIT licence.

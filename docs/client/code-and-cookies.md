# The Code tab and the cookies

## The Code tab

The *Code* tab of the response pane writes the request **as it would be sent now** as code in a language, so that you can run it somewhere else. Pick the language, read it, press *Copy*. Nothing is sent: building the code does not run the scripts and does not ask for an access token.

Languages: cURL, PowerShell, JavaScript (fetch), JavaScript (axios), Python (requests), Go (net/http), C# (HttpClient), PHP (cURL), Java (HttpClient). The variables are replaced with their values, headers and bodies are written as the request has them, and **every secret value is written as `[redacted]`** (the values of secret variables and of tokens, and what is named like a secret), so that a snippet pasted into a chat or a ticket does not carry a token. The notes above the code say what you have to put back. A form body is written as fields, a body that is a file as `./name` (the folders of your machine are not in the code), a multipart body with its parts.

The strings are written for the language (quotes, backslashes, line breaks, the characters that cannot be in a string), and the output of each language is checked against a real client: the cURL and fetch output was run against a local server, and the Go, PHP, Java and C# output was compiled.

## Cookies

The cookies that servers set are kept and sent back to the same site, per request setting *cookies* (on by default). *Show Cookies* lists them (name, site, path, when it ends, Secure, HttpOnly, SameSite) and you can pick the ones to delete; **the value of a cookie is never shown in a list**. *Delete All Cookies* clears them all.

A cookie is a credential. Only a cookie that has an end date outlives the session, and it is kept in the secret storage of VS Code (not in a file, not in the workspace), so that a login survives closing the window; a cookie with no end date is forgotten when the window closes. A cookie is only sent to the site that set it (a cookie of `a.example` is not sent to `b.example`), and not on a redirect to another origin.

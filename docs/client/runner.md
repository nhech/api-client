# The collection runner

*Run Collection or Folder* (the context menu of a collection or a folder in the side bar, or the Command Palette) opens a panel that runs the requests one after the other, shows each result as it comes, and saves a report. It is the same send as pressing Send on one request: the scripts before and after, the access token, the tests and captures (`extension/src/execute.ts`). What is new is the order, the passes and the pauses (`src/runner/`, pure and tested without a server).

## What it runs

The requests of the collection or folder in the order the side bar shows them, folders opened in place, as they are **saved** (an unsaved edit in an open editor is not run). A run holds at most 10,000 requests, 1,000 passes and 10,000 executions in all.

- **Passes**: how many times the whole list is run. With a data file the rows decide.
- **Pause between requests**: 0 to 60,000 ms, not after the last request.
- **Stop at the first failure**: a request fails when a test fails, and is an error when it could not be sent, a script failed, or a token could not be had.
- **Data file**: CSV (commas, semicolons or tabs; quoted fields; the first row names the columns) or JSON (a list of objects). Each row is one pass; every column is a variable for the requests of that pass (weaker than what a script or a capture sets) and `pm.iterationData` for the scripts. Up to 10,000 rows, 200 columns, 64 KB a cell; a column name has to be a name a variable can have.
- **Scripts steer the run**: `postman.setNextRequest('name')` goes to that request (by name), `setNextRequest(null)` ends the pass, `pm.execution.skipRequest()` skips one. A script that always sends the run back is stopped by the limit on executions.

Variables that scripts and captures set stay set for the whole session, as when requests are sent one by one; "Clear Saved Variables" forgets them.

## What it shows and keeps

Each result: the request, the pass, passed / failed / error / skipped, the status, the time and size, and the tests (declarative and `pm.test`) with their messages. The panel keeps the last 2,000 results; the report has all of them. A panel that is closed and opened again is told everything that happened (the run belongs to the session, not the panel). A response that went to a file is deleted as soon as the request is judged: a run keeps what it needs of each answer, not the answers.

## Reports

*Save the report (JSON)* and *(JUnit XML)* write what ran: the totals, and for each request the pass, the result, the status, the time, the tests and the notes. **Nothing a server answered and no address** is in them. The same run gives the same text (the time the run began is the only clock in them). JUnit has a test suite for each execution and a test case for each test; a request with no tests is one passing case, an error is an `<error>`, a skipped request is `<skipped/>`.

## Not yet

Running requests in parallel, a command line (`api-client run`) and a report as HTML are for later versions. The runner always uses the active environment.

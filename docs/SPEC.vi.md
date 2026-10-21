# Đặc tả importer: Thunder Client → API client mới

Trạng thái: 0.1, 2026-10-21 (xem [CHANGELOG](../CHANGELOG.md)).
Phạm vi: chỉ phần **nhập dữ liệu từ Thunder Client** (bộ chuyển đổi ra file `.http`). Runtime gửi request nay nằm trong cùng extension (mã định danh `longtd.api-client`) và có tài liệu riêng ở [docs/client/](client/) và [SECURITY.md](../SECURITY.md); các ràng buộc dưới đây (C1 đến C4) là của **bộ chuyển đổi**, trừ khi ghi khác.

Tên extension: **HTTP Files Importer** (chốt 2026-10-21; mã định danh `longtd.http-files-importer`). Tên và icon không chứa chữ "Thunder Client"; mô tả và từ khóa chỉ dùng tên đó để chỉ định dạng nguồn ("nhập collection của Thunder Client"), kèm lời nói rõ là không liên kết với Thunder Client (README). Phần còn lại của tài liệu gọi sản phẩm tương lai là "API client".

## 0. Cách đọc tài liệu này

Mỗi khẳng định về định dạng có nhãn nguồn:

| Nhãn | Nghĩa |
|---|---|
| `[FILE]` | Thấy trong file xuất thật (repo công khai của LSEG, xuất 2021, định dạng `version "1.1"`) |
| `[CODE]` | Thấy trong mã của gói `rangav.vscode-thunder-client` 3.0.0 (17/10/2026), đã đọc, không chạy |
| `[FIXT]` | Thấy trong fixture của OWASP Noir (do bên thứ ba viết tay, đúng cấu trúc nhưng giá trị là giả) |
| `[DOC]` | Tài liệu chính thức docs.thunderclient.com |
| `[?]` | **Chưa xác minh.** Phải đóng bằng file thật trước khi coi là đúng (xem §12) |

Schema trên apis.io **không dùng làm nguồn**: đối chiếu với file thật thì sai (loại test, cấu trúc môi trường).

## 1. Mục tiêu, không mục tiêu, ràng buộc

### 1.1 Mục tiêu

- G1. Người dùng đang kẹt sau màn hình đăng nhập của Thunder Client 3.0.0 lấy lại được toàn bộ request, thư mục, môi trường **chỉ bằng đọc file trên đĩa**, không cần xuất, không cần đăng nhập.
- G2. Kết quả là file văn bản nằm trong repo, diff được, sạch bí mật.
- G3. Mọi thứ không chuyển được đều được **nói rõ** (báo cáo chuyển đổi), không im lặng bỏ.
- G4. Chạy lại nhiều lần cho cùng kết quả byte-for-byte.

### 1.2 Không mục tiêu (bản đầu)

- Không chạy script, không gửi request, không gọi mạng khi chuyển đổi hay khi nhập.
- Không giải mã giá trị môi trường đã mã hóa (§8.4).
- Không ghi vào thư mục của Thunder Client. Không xóa, không sửa nguồn.
- Không hỗ trợ WebSocket, SSE, gRPC (§5.9).
- Không import từ Postman/Insomnia/Bruno/cURL trong tài liệu này. Kiến trúc IR (§4) chừa chỗ cho chúng.

### 1.3 Ràng buộc sản phẩm

- **C1. Trước mắt miễn phí.** Không tài khoản, không đăng nhập, không kiểm tra giấy phép, không giới hạn số collection hay số request (Thunder 3.0.0 free: 3 collection, 30 request mỗi collection `[DOC]`). Không viết sẵn móc cho paywall; nếu sau này đổi hướng thì thêm sau.
- **C2. Chạy hoàn toàn cục bộ.** Bộ chuyển đổi không dùng mạng và không telemetry, kể cả khi lỗi (test kiểm rằng mã của nó không import module mạng nào). Client gửi request của extension chỉ gửi những request người dùng gửi và, với OAuth 2.0, các request tới máy chủ token đã cấu hình; không telemetry, không tài khoản.
- **C3. Chỉ chạy khi người dùng ra lệnh.** Không quét ổ đĩa lúc kích hoạt extension, không đọc thư mục của extension khác ở nền.
- **C4. Core thuần.** Đọc → chuẩn hóa → phát ra là hàm thuần, không phụ thuộc API `vscode`, test bằng `node:test` như Git Pro. Phần VS Code chỉ có: chọn nguồn, hiện báo cáo, xác nhận, ghi file.

## 2. Nguồn đầu vào

### 2.1 Bốn loại nguồn

| Mã | Nguồn | Nhận diện |
|---|---|---|
| S1 | Thư mục lưu trữ của Thunder Client (`globalStorage/rangav.vscode-thunder-client`, thư mục tùy chỉnh, hoặc `thunder-tests/` trong workspace) | có `collections/tc_col*.json` (v4) hoặc `thunderclient.json` / `thunderCollection.json` (v3) |
| S2 | File xuất collection | JSON object có `collectionName` và `requests`, tên thường `thunder-collection_<tên>.json` `[FILE]` |
| S3 | File xuất môi trường | JSON object có `environmentName` và `variables`, tên thường `thunder-environment_<tên>.json` `[FILE]` |
| S4 | File lẻ lấy từ S1 | phân loại theo nội dung (§2.3) |

Quy tắc nhận diện theo **nội dung**, không theo tên file.

### 2.2 Bố cục thư mục lưu trữ (S1)

`[CODE]` Bộ nạp của Thunder Client chọn bố cục thế này; importer dùng đúng quy tắc đó:

1. Nếu `<root>/collections/` có ít nhất một file tên bắt đầu bằng `tc_col` → **v4**.
   - Collection: `collections/tc_col_<tên>.json`, mỗi file một object collection.
   - Môi trường: `environments/tc_env_<tên>.json`, mỗi file một object môi trường.
2. Ngược lại, nếu có `thunderclient.json` hoặc `thunderCollection.json` ở gốc → **v3**.
   - `thunderclient.json`: mảng request phẳng, mỗi phần tử có `colId`.
   - `thunderCollection.json`: mảng collection `{ _id, colName, folders, settings }`, không chứa request.
   - `thunderEnvironment.json`: mảng môi trường.
3. Nếu cả hai tồn tại: dùng v4, bỏ v3, báo `TC-LAYOUT-BOTH`. Ngoại lệ: **`thunderLocalEnvironment.json` luôn được đọc, ở cả hai bố cục** `[CODE]` (hàm khởi động của extension nạp nó không điều kiện), nên biến cục bộ của máy có thể nằm ở đó dù dùng v4; file này đứng một mình không tính là bố cục v3. Cần xác nhận trên dữ liệu thật (OQ7).

Cách đọc (đã cài trong `src/reader/fs-reader.ts`): **chỉ đọc đúng các tệp đã biết**, không duyệt đệ quy: thư mục gốc, `collections/`, `environments/`. Tệp là liên kết (symlink, junction) bị bỏ kèm thông báo mức info; thư mục con có đường dẫn thật nằm ngoài nguồn cũng bị bỏ. Mọi giới hạn cục bộ của một tệp (dung lượng, độ sâu, chuỗi dài) chỉ bỏ tệp đó; mọi giới hạn **toàn cục** (tổng dung lượng, số tệp, số request) dừng hẳn việc đọc, báo một lần, để kết quả không phụ thuộc vào việc một tệp nhỏ đến sau có lọt hay không.

Bỏ qua hoàn toàn:

- `thunderActivity.json`, `thunderResponses.json` (lịch sử và response đã lưu).
- Thư mục `_db-backup`, `_db-backupv3` (bản sao lưu của lần nâng cấp v3 → v4).
- Thư mục `files/`, `res-files/` (tệp đính kèm; xem `TC-FILE-PATH`).
- Mọi request có `colId == "history"` `[CODE]` (đó là mục lịch sử, không thuộc collection nào).

`thunderLocalEnvironment.json` (môi trường cục bộ ở v3) `[CODE: tên file]`: cấu trúc chưa thấy, xem §12.

### 2.3 Phân loại file lẻ theo nội dung

| Hình dạng JSON | Loại |
|---|---|
| object có `colName` + `requests` (mảng) | collection v4 |
| object có `name` + `data` (mảng) | môi trường v4 |
| object có `collectionName` + `requests` | xuất collection |
| object có `environmentName` + `variables` | xuất môi trường |
| mảng, phần tử có `colId` và `url` | request v3 |
| mảng, phần tử có `colName` | collection v3 |
| mảng, phần tử có `name` và `data` | môi trường v3 |
| còn lại | bỏ qua, báo `TC-PARSE-ERROR` mức info |

### 2.4 Tìm thư mục lưu trữ mặc định

Không quét. Lệnh chỉ **gợi ý** vài đường dẫn và luôn cho phép "Chọn thư mục…".

1. Thư mục của **trình soạn thảo đang chạy**: `path.dirname(context.globalStorageUri.fsPath)` rồi nối `rangav.vscode-thunder-client`. Cách này đúng cho cả Cursor, VSCodium, Windsurf... vì không phải đoán tên thư mục dữ liệu.
2. Các thư mục của biên bản khác trên cùng máy, nối từ gốc dữ liệu người dùng:
   - Windows: `%APPDATA%\<Ứng dụng>\User\globalStorage\rangav.vscode-thunder-client` `[DOC: chỉ ghi ứng dụng Code]`
   - macOS: `~/Library/Application Support/<Ứng dụng>/User/globalStorage/…`
   - Linux: `~/.config/<Ứng dụng>/User/globalStorage/…`
   - VS Code Server: `~/.vscode-server/data/User/globalStorage/…`
   - `<Ứng dụng>` thử: `Code`, `Code - Insiders`, `VSCodium`. Tên cho Cursor, Windsurf, Kiro, Antigravity `[?]`.
3. Mỗi gợi ý chỉ hiển thị nếu thư mục **tồn tại**, kèm số collection/request/môi trường đếm được bằng quét tên file (chưa đọc nội dung bí mật).
4. Cài đặt `thunder-client.customLocation`, `saveToWorkspace`, `workspaceRelativePath` `[CODE]` chỉ có hiệu lực khi người dùng có thuê bao; đừng đọc cài đặt của extension khác. Nếu người dùng dùng Git sync, họ sẽ chọn `thunder-tests/` bằng tay.

## 3. Mô hình dữ liệu nguồn (như quan sát được)

Kiểu dưới đây là **lỏng có chủ đích**: mọi trường tùy chọn, mọi giá trị có thể sai kiểu. Importer không tin kiểu, luôn kiểm tra (§8).

```ts
type Text = string | string[] | undefined;            // N1: chuỗi hoặc mảng dòng

interface TcKeyValue { name?: string; value?: string; isDisabled?: boolean; isPath?: boolean; encrypted?: boolean; }

interface TcRequest {                                  // [FILE][FIXT][CODE]
  _id?: string; colId?: string; containerId?: string;  // containerId '' = gốc collection
  name?: string; url?: string; method?: string;
  sortNum?: number; created?: string; modified?: string;
  headers?: TcKeyValue[];
  params?: TcKeyValue[];                               // isPath = tham số đường dẫn (:name)
  body?: { type?: string; raw?: Text; form?: TcKeyValue[]; files?: TcKeyValue[]; graphql?: { query?: Text; variables?: Text } };
  auth?: TcAuth;                                       // vắng hoặc type "inherit" = kế thừa (N16) [CODE]
  tests?: TcTest[];
  docs?: Text;                                         // [CODE]
  reqType?: string;                                    // [CODE] http | ws | sse | grpc | graphql [?]
  preReq?: { inlineScripts?: { script?: string[] }[]; options?: { skipRequest?: boolean } };  // [CODE]
  postReq?: { inlineScripts?: { script?: string[] }[] };                                      // [CODE]
  cookies?: unknown; settings?: unknown;               // [CODE: tên trường] cấu trúc [?]
}

interface TcTest { type?: string; custom?: string; action?: string; value?: string | number; }  // [FILE][CODE]

interface TcFolder { _id?: string; name?: string; containerId?: string; sortNum?: number; created?: string; settings?: TcSettings; }

interface TcCollection { _id?: string; colName?: string; sortNum?: number; created?: string; folders?: TcFolder[]; requests?: TcRequest[]; settings?: TcSettings; }  // v4 [FIXT][CODE]

interface TcAuth { type?: string; bearer?: string; basic?: { username?: string; password?: string }; oauth2?: Record<string, unknown>; /* apikey, digest, aws, ntlm: trường [?] */ }

// Cấu hình ở cấp collection và thư mục. [CODE: đọc từ hàm dựng "request hiệu lực"]
interface TcSettings {
  docs?: Text; envId?: string; runOptions?: unknown;
  options?: { baseUrl?: string };
  headers?: TcKeyValue[];
  auth?: TcAuth;                                       // type: "inherit" | "none" | loại thật
  tests?: TcTest[];
  preReq?: { runRequests?: unknown[]; runFilters?: unknown[]; inlineScripts?: { script?: string[] }[]; options?: { clearCookies?: boolean; skipRequest?: boolean } };
  postReq?: { runFilters?: unknown[]; inlineScripts?: { script?: string[] }[] };
}

interface TcEnvironment { _id?: string; name?: string; default?: boolean; global?: boolean; local?: boolean; sortNum?: number; data?: TcKeyValue[]; envFile?: string; }  // [CODE]

// File xuất (S2, S3) [FILE]
interface TcExportCollection { client?: string; collectionName?: string; dateExported?: string; version?: string; folders?: TcFolder[]; requests?: TcRequest[]; }
interface TcExportEnvironment { client?: string; environmentName?: string; dateExported?: string; version?: string; variables?: { name?: string; value?: string }[]; }
```

Giá trị quan sát được:

- `body.type`: `json`, `formencoded`, `formdata` `[FILE][FIXT]`; mã còn biết `text`, `xml`, `binary`, `graphql`, `none` `[CODE]`.
- `auth.type`: `bearer`, `basic`, `none` `[FILE][FIXT]`; mã còn biết `oauth2`, `apikey`, `digest`, `aws`/`awsv4`, `ntlm` `[CODE]`.
- `tests[].type`: `res-code`, `res-body`, `res-time`, `Content-Type`, `Content-Length`, `Content-Encoding`, `custom-header`, `json-query`, `set-env-var` `[CODE]`.
- `tests[].action`: `equal`, `notequal`, `contains`, `notcontains`, `count`, `istype`, `isjson`, `regex`, `schema`, `setto`, `<`, `<=`, `>`, `>=` `[CODE]`.
- Phiên bản file xuất: `"1.1"` (collection), `"1.0"` (môi trường) `[FILE]`; bản mới hơn `[?]`.
- Biến trong chuỗi: `{{tên}}` (giống REST Client); biến hệ thống `{{#guid}}`… (§5.7).

## 4. Kiến trúc: ba tầng

```
Đọc (reader)  ──►  Chuẩn hóa (normalize)  ──►  IR  ──►  Phát (emitter)
 S1..S4              N1..N14                             E1 (đề xuất)
 trả TcSource        thuần, có báo cáo                   + báo cáo
```

- **Reader**: duyệt thư mục hoặc nhận nội dung file, trả `TcSource` (danh sách file đã phân loại + JSON đã parse). Mọi giới hạn kích thước ở đây (§8).
- **Normalize**: `TcSource → ImportModel` (IR). Hàm thuần, xác định, không IO. Sinh `Finding[]`.
- **Emitter**: `ImportModel → OutputFile[]`. Đổi emitter không đụng reader hay normalize.
- **Writer** (tầng VS Code): ghi `OutputFile[]` (§9).

### 4.1 IR

```ts
interface ImportModel { collections: ImpCollection[]; environments: ImpEnvironment[]; findings: Finding[]; }

interface ImpCollection { id: string; name: string; docs?: string; baseUrl?: string; root: ImpContainer; }
interface ImpContainer { name: string; docs?: string; requests: ImpRequest[]; folders: ImpContainer[]; }   // đã sắp theo sortNum

interface ImpRequest {
  sourceId: string; name: string; docs?: string;
  method: string; url: string;                          // url đã khử query trùng (N2), path param đã thế (N3)
  query: { name: string; value: string; enabled: boolean }[];   // hiển thị, đã hợp nhất với url
  headers: { name: string; value: string; enabled: boolean; secret: boolean }[];
  body?: ImpBody;
  auth?: ImpAuth;
  assertions: ImpAssertion[];
  captures: ImpCapture[];
  skippedScripts?: { phase: 'pre' | 'post'; lines: string[] };   // giữ để ghi chú
}
type ImpBody =
  | { kind: 'text'; contentType: string; text: string }
  | { kind: 'form'; fields: { name: string; value: string; enabled: boolean }[] }
  | { kind: 'multipart'; parts: { name: string; value?: string; filePath?: string; enabled: boolean }[] }
  | { kind: 'graphql'; query: string; variables?: string };
type ImpAuth =
  | { kind: 'bearer'; token: Secretish } | { kind: 'basic'; username: Secretish; password: Secretish }
  | { kind: 'unsupported'; type: string };
interface Secretish { value: string; secret: boolean }
interface ImpAssertion { target: 'status' | 'time' | 'body' | 'header' | 'json'; name?: string; op: string; expected: string }
interface ImpCapture { variable: string; scope: 'active' | 'local' | 'global'; source: string; }   // source: json.x | text | header.x | cookie.x | literal | null | delete

interface ImpEnvironment { name: string; kind: 'shared' | 'named' | 'private'; isDefault: boolean; variables: { name: string; value: string; secret: boolean; needsReentry: boolean }[]; envFile?: string; }

interface Finding { code: string; severity: 'info' | 'warn' | 'error'; where: string; message: string; }   // where: "Collection / Folder / Request" hoặc đường dẫn file
```

## 5. Quy tắc chuẩn hóa và ánh xạ

### 5.1 Chuẩn hóa (N1–N14)

| # | Quy tắc |
|---|---|
| N1 | `Text` → chuỗi: mảng thì nối bằng `\n`; `undefined` thành rỗng. Áp dụng cho `body.raw`, `body.graphql.query`, `body.graphql.variables`, `docs`, `settings.docs`. `[CODE]` Thunder tự chuyển chuỗi ↔ mảng dòng khi nạp; trên đĩa có thể là một trong hai. |
| N2 | **`url` là nguồn thật cho query của các param đang bật; `params` chỉ nhân bản.** `[FILE]` (xuất 2021): `url` = `.../basic?universe={{symbol}}` và `params` = `[{universe}]`. Cách làm: tách query khỏi `url`; param bật mà **có trong url** (cùng tên và giá trị) → giữ một lần; param bật **không có trong url** → nối vào cuối, báo `TC-PARAM-NOT-IN-URL`; param tắt (`isDisabled`) → thành dòng chú thích (§6.3). |
| N3 | Tham số đường dẫn `[FIXT]`: `params[i].isPath === true` với `url` chứa `:name` → thế `:name` bằng `value` (giữ nguyên `{{biến}}` bên trong). Không có giá trị → giữ `:name`, báo `TC-PATHPARAM-EMPTY`. Chỉ thế khi `:name` đứng trọn một đoạn đường dẫn (không phải cổng `:8080`, không phải sau `?`). |
| N4 | Header mặc định của Thunder: bỏ `Accept: */*` và `User-Agent` chứa `thunderclient` khi đang bật `[CODE: hàm lọc của chính họ]`. Báo gộp một dòng info `TC-HEADER-DEFAULT-DROPPED` mỗi request. Các header khác giữ nguyên. |
| N5 | Thứ tự: collection, thư mục, request, môi trường sắp theo `sortNum` tăng dần, hòa thì `created`, hòa nữa thì `name` (so sánh theo điểm mã, không theo locale). Thiếu `sortNum`, hay không phải số hữu hạn, coi như 0; thiếu `created` xếp trước. Kết quả **không phụ thuộc thứ tự mảng đầu vào**, nên còn hai khóa hòa nữa: `_id`, rồi văn bản chuẩn hóa (khóa theo điểm mã) của chính mục đó. `[ĐÃ CÀI: src/normalize/order.ts]` |
| N6 | Cây thư mục theo `containerId` (`""`, vắng hay không phải chuỗi = gốc, không báo gì). Cha không tồn tại → đưa lên gốc, báo `TC-ORPHAN-FOLDER`. Chu trình (kể cả thư mục là cha của chính nó) → cắt **tại thư mục đứng đầu trong thứ tự N5 của vòng đó**, thư mục ấy lên gốc, báo `TC-CYCLE` một lần mỗi vòng; chọn như vậy để không phụ thuộc điểm bắt đầu duyệt hay thứ tự dữ liệu. Độ sâu tối đa 32 (gốc = 1): thư mục sâu hơn **được gộp vào tổ tiên ở mức 32** (request của chúng chuyển sang đó, chúng biến khỏi cây), báo `TC-DEPTH` một lần mỗi collection kèm số thư mục; **mỗi request vẫn giữ nguyên chuỗi tổ tiên thật** (kể cả thư mục đã gộp) để kế thừa N15–N19 đúng. Request có `containerId` không tồn tại → gốc collection, báo `TC-ORPHAN-REQUEST`. `_id` thư mục trùng nhau thuộc về thư mục đầu tiên theo N5; thư mục không có `_id` vẫn được giữ nhưng không ai trỏ tới được. Mọi báo cáo giữ 20 mục đầu của một mã trong một collection, phần còn lại gộp thành một dòng "còn N mục nữa". Mọi bước duyệt là vòng lặp tuyến tính (chuỗi 100.000 thư mục hay một vòng 100.000 thư mục chạy trong khoảng 100 ms). `[ĐÃ CÀI: src/normalize/folders.ts]` |
| N7 | v4 và file xuất: mỗi file là **một collection và sở hữu request của nó** (bất kể `colId` ghi gì); id của collection xuất là `export:<file>`. v3: gom request theo `colId` bằng `thunderCollection.json`; `colId` trùng ở hai collection thuộc về collection đứng trước theo N5; `colId` vắng, rỗng hoặc không có collection → collection **"Unsorted"** (luôn đứng cuối, `containerId` của chúng bị bỏ qua nên không báo thêm lỗi thư mục), báo `TC-ORPHAN-REQUEST` cho từng request. `colId == "history"` → bỏ (cả trong file v4), đếm **một lần mỗi file** vào `TC-HISTORY-SKIPPED` (info). `[ĐÃ CÀI: src/normalize/group.ts]` |
| N8 | `method`: chuẩn hóa chữ hoa; rỗng → `GET`; phải khớp `/^[A-Z][A-Z0-9_-]{0,31}$/`, không thì `GET` + `TC-METHOD-INVALID`. Phương thức lạ hợp lệ (`PROPFIND`…) được giữ. |
| N9 | `reqType` vắng hoặc `http` → HTTP thường. `ws`, `sse`, `grpc` → bỏ request, báo `TC-REQTYPE-UNSUPPORTED`. `graphql` `[?]`: xử lý như request HTTP có `body.type == graphql`. |
| N10 | Mọi giá trị chuỗi sai kiểu (số, bool, null) → `String(v)` nếu là số/bool, rỗng nếu null/object; báo `TC-VALUE-COERCED` (gộp một dòng mỗi file). |
| N11 | `version` lạ của file xuất → vẫn đọc theo hình dạng, báo `TC-VERSION-UNKNOWN` mức info. `[ĐÃ CÀI: src/normalize/build.ts]` "Quen" là các phiên bản thấy trong file công khai: `1.1` cho collection, `1.0` cho môi trường; file không có `version` thì không báo. Giá trị lạ chỉ được hiện nếu là chuỗi ngắn (`[0-9A-Za-z._-]{1,12}`), nếu không báo "không phải số phiên bản ngắn". |
| N12 | Mã hóa: UTF-8, bỏ BOM. Ký tự điều khiển (trừ `\t \n \r`) trong tên bị thay (§6.1). |
| N13 | Môi trường: `data[]` hoặc `variables[]`; trùng tên biến trong cùng môi trường → giữ cái cuối, báo `TC-ENV-DUP`. Biến `isDisabled` → bỏ, đếm info. |
| N14 | Cờ môi trường `[CODE]`: `global && !local` = **dùng chung**; `global && local` = **cục bộ** (không nên vào Git); còn lại = môi trường có tên. `default: true` ghi nhận làm môi trường mặc định (§6.5). |

**Kế thừa (N15–N19)** `[CODE]`: Thunder dựng một "request hiệu lực" trước khi gửi bằng cách đi từ thư mục chứa request ngược lên các thư mục cha rồi tới collection (theo `containerId`, tới `settings` của collection). Importer **làm phẳng** kết quả đó vào từng request (D2, §6.0), nên phải tái hiện đúng thuật toán. Gọi "chuỗi tổ tiên" là danh sách `[thư mục gần nhất, …, thư mục xa nhất, collection]`.

| # | Quy tắc |
|---|---|
| N15 | **baseUrl.** Lấy `settings.options.baseUrl` của phần tử **đầu tiên** trong chuỗi tổ tiên có giá trị (gần nhất thắng). Nếu `url` khác rỗng và **không** bắt đầu (không phân biệt hoa thường) bằng `http://`, `https://` hay `{{` → `url = baseUrl + url`. Điều kiện "không bắt đầu bằng `http://`, `https://`, `{{`" lấy từ hàm xuất Postman của họ `[CODE]`; hàm dựng request lúc chạy chỉ ghi `url = baseUrl + url`, nên điều kiện lúc chạy `[?]`. Có áp dụng thì báo `TC-INHERIT-BASEURL` (info). |
| N16 | **Auth.** `auth.type` của request vắng hoặc `inherit` → xét `settings.auth` của chuỗi tổ tiên, từ gần đến xa: loại vắng coi là `inherit`; gặp `none` → không có auth, dừng; gặp loại thật → dùng nguyên đối tượng đó, dừng; tới collection mà loại vắng hoặc `none` → không có auth. Request có loại thật (kể cả `none`) thì **không** kế thừa. Báo `TC-INHERIT-AUTH` (info) kèm nơi lấy. Với `oauth2`, `[CODE]` Thunder còn gắn `authId` và `accessToken` lúc chạy từ kho token riêng: **không nhập token** (§5.5). |
| N17 | **Header.** Đi từ gần đến xa; mỗi header `h` của `settings.headers`: nếu request (đã gồm các header thêm trước đó) **chưa có header bật cùng `name`** (so sánh chính xác, phân biệt hoa thường, giống Thunder) thì thêm `h` nguyên trạng, kể cả cờ `isDisabled` của nó. Gần nhất thắng. Báo `TC-INHERIT-HEADERS` (info, kèm số lượng). Sau đó mới áp N4 (bỏ header mặc định) và so sánh tên header **không phân biệt hoa thường** khi phát ra (HTTP không phân biệt); trùng tên khác hoa thường → giữ cái đến sau, báo `TC-HEADER-DUP`. |
| N18 | **Test.** Test của request đứng trước; sau đó, đi gần đến xa, thêm từng test trong `settings.tests` trừ khi request (đã gồm test thêm trước) có test **cùng `type`, `custom`, `action`** *và* `action` thuộc `equal`, `<`, `<=`, `>`, `>=`, `schema`, `istype`, `count`, `isjson`. Các action khác (`contains`, `regex`…) luôn được thêm. Báo `TC-INHERIT-TESTS` (info). |
| N19 | **Script và "chạy trước".** `settings.preReq`/`postReq` (`inlineScripts`, `runFilters`) được ghép **thứ tự từ xa đến gần**: collection, các thư mục cha…, thư mục gần nhất, rồi mới đến request. `settings.preReq.runRequests` (yêu cầu chạy request khác trước) cũng kế thừa. Importer **không chạy gì cả**: script thừa kế được ghi chú như §5.9 (gắn nhãn nơi lấy), `runRequests` báo `TC-PREREQ-RUN` (warn: luồng "chạy trước" không chuyển được). `preReq.options` (`clearCookies`, `skipRequest`) lấy từ tổ tiên gần nhất, trừ khi request đã tự đặt `clearCookies`. |

### 5.2 Request line

`METHOD <url>`. Không thêm `HTTP/1.1`. URL sau N2, N3. Biến `{{…}}` giữ nguyên.

### 5.3 Header

Header bật → `Name: value`. Header tắt → dòng chú thích `# [disabled] Name: value`. Tên header giữ nguyên chữ hoa/thường như nguồn.

Thunder tự thêm `Content-Type` theo loại body (cài đặt `contentType`, mặc định bật `[CODE]`) nên file xuất **không** chứa header đó. Importer phải thêm `Content-Type` tương ứng (§5.4) trừ khi đã có header `Content-Type` bật, vì REST Client không tự thêm.

### 5.4 Body

| Nguồn | Phát ra | Content-Type thêm |
|---|---|---|
| `json` | `raw` nguyên văn | `application/json` |
| `text` | `raw` | `text/plain` `[?]` |
| `xml` | `raw` | `application/xml` `[?]` |
| `formencoded` | `tên=giá trị&…`, chỉ trường bật; ký tự thường được mã hóa phần trăm, **đoạn `{{…}}` giữ nguyên** | `application/x-www-form-urlencoded` |
| `formdata` | multipart, ranh giới cố định `----ApiClientImport`; trường văn bản và `files[]` (phần tệp dùng `< đường/dẫn`) | `multipart/form-data; boundary=----ApiClientImport` |
| `graphql` | JSON `{"query":…,"variables":…}` (variables đúng JSON thì nhúng như object, không thì như chuỗi, báo `TC-GRAPHQL-VARS`) | `application/json` |
| `binary` `[?]` | không hỗ trợ, báo `TC-BODY-UNSUPPORTED` | |
| `none` hoặc vắng | không có body | |

Trường form tắt không thể chú thích trong body → ghi thành chú thích **phía trên** request: `# [disabled form field] tên=giá trị`.

Đường dẫn tệp trong `files[]` `[FIXT]` (`./invoice.pdf`): giữ nguyên, **không sao chép tệp**, báo `TC-FILE-PATH` (tệp nằm ngoài repo hoặc đường dẫn tuyệt đối). Đường dẫn tuyệt đối chứa tên người dùng bị đổi thành `<đường dẫn bị ẩn>` trong báo cáo (không trong file).

### 5.5 Xác thực

| Nguồn | Phát ra |
|---|---|
| `inherit`, hoặc `auth` vắng | kế thừa theo N16, rồi xử lý như loại thật tìm được |
| `none` | không có gì |
| `bearer` | `Authorization: Bearer <token>`. Nếu đã có header `Authorization` bật → header thắng, báo `TC-AUTH-HEADER-CONFLICT` |
| `basic` | `Authorization: Basic <username>:<password>` (dạng REST Client tự mã hóa khi gửi). **Không tự tính base64** để khỏi ghi bí mật dưới dạng khó nhận ra |
| `oauth2` | không đoán. Ghi chú thích `# [auth oauth2 not imported]` kèm cấu trúc đã **xóa giá trị bí mật**, báo `TC-AUTH-OAUTH2` |
| `apikey`, `digest`, `aws`, `awsv4`, `ntlm` | không hỗ trợ, `TC-AUTH-UNSUPPORTED` |

Trường của `oauth2` và `apikey` `[?]` (xem §12).

### 5.6 Docs

`docs` của request (và của folder, collection) thành khối chú thích `# …` ngay dưới dòng tiêu đề request. Mỗi dòng thêm `# `. Dòng rỗng thành `#`.

### 5.7 Biến

- `{{tên}}` → giữ nguyên.
- Hậu tố phạm vi `{{tên, local}}`, `{{tên, global}}` chỉ gặp ở đích của `set-env-var` `[DOC]` (§5.8), không phải ở tham chiếu.
- Biến động của Thunder `[ĐỌC TỪ MÃ 3.0.0]` dùng tiền tố `#`. Ba công cụ đích viết chúng **khác nhau** (đã thử thật từng công cụ, §10.3b, c, d), nên importer có tùy chọn **đích** `target` (`rest-client` mặc định, `httpyac`, `jetbrains`; dòng lệnh `--target`, Quick Pick "Written for") và phát ra đúng cách viết của công cụ đó. Báo cáo ghi "Written for …".

Ngữ nghĩa của Thunder (đọc từ mã, không chạy gì): `#guid` là UUID v4; `#number, a, b` là số nguyên từ `a` đến `b` **gồm cả hai đầu**, mặc định `a` = 1 và `b` = 1.000.000, `a` từ 990.000 trở lên bị coi là 1, `b` trên 1.000.000 bị coi là 1.000.000; `#date` là thời điểm hiện tại tính bằng mili giây; `#dateISO` là `toISOString()` (UTC, mili giây).

| Nguồn | REST Client | httpYac | JetBrains |
|---|---|---|---|
| `{{#guid}}` | `{{$guid}}` | `{{$guid}}` | `{{$uuid}}` (`$guid` không có) |
| `{{#number}}`, `{{#number, a}}`, `{{#number, a, b}}` (a ≤ b sau khi áp quy tắc của Thunder) | `{{$randomInt a b+1}}` | `{{$randomInt a b+1}}` | `{{$random.integer(a, b+1)}}` |
| `{{#dateISO}}` (không đối số) | `{{$datetime iso8601}}` | `{{$datetime iso8601}}` | `{{$isoTimestamp}}` (nano giây thay vì mili giây) |
| `{{#date}}` (không đối số, mili giây) | giữ nguyên | `{{$timestamp}}` (httpYac cho mili giây) | giữ nguyên |
| `{{#name}}`, `{{#string}}`, `{{#email}}`, `{{#bool}}`, `{{#enum, …}}`, mọi dạng có đối số khác | giữ nguyên | giữ nguyên | giữ nguyên |

Vì sao `b+1`: cả ba công cụ cho số từ `a` **đến trước** `b` (đo bằng 16 lần gọi `$randomInt 1 3` ở REST Client và httpYac, `$random.integer(1, 3)` ở httpYac và JetBrains: chỉ ra 1 và 2, không bao giờ 3; đo trên request do importer sinh: 24 lần lăn xúc xắc `{{#number, 1, 3}}` cho đủ {1, 2, 3} ở cả ba). Bản đầu của importer viết `$randomInt a b` nên **không bao giờ ra `b`**. `$timestamp` là mili giây ở httpYac (13 chữ số) và giây ở hai công cụ kia nên `#date` chỉ ánh xạ cho httpYac. `$randomInt a b` ở JetBrains **bỏ qua khoảng** (ra 0 đến 1000) và `$guid` không chạy, nên JetBrains dùng dạng riêng.

Biến chưa ánh xạ **được giữ nguyên** để người dùng thấy ngay chỗ chưa chạy, và liệt kê theo tên trong báo cáo (`TC-SYSVAR-UNMAPPED`). Bảng ánh xạ nằm trong `src/convert/sysvars.ts` (`SPELLINGS`), thêm một công cụ đích là thêm một dòng ở đó.

### 5.7a Chữ trông như mã giữa `{{ }}` `[ĐÃ CÀI: src/convert/expressions.ts; đã thử thật trong httpYac 6.16.7]`

Trong Thunder, `{{…}}` chỉ là biến. Trong công cụ đọc tệp `.http` thì có thể nhiều hơn: **httpYac chạy nội dung giữa hai dấu ngoặc như JavaScript** (đã thử: một biểu thức trong body, trong header và trong URL đều chạy và ghi ra tệp; `{{$processEnv TÊN}}` đưa biến môi trường vào request). Một collection do người khác tạo có thể chạy mã hoặc làm lộ biến môi trường khi người dùng bấm Gửi.

Quy tắc: một cặp `{{ … }}` chỉ được giữ nguyên nếu phần giữa là **tên biến thuần**: không dấu chấm (chuỗi `process.env.X` là đường dẫn), không ngoặc đơn/vuông/nhọn, nháy, toán tử, `$`, `#`, `@`, dấu hai chấm, dấu phẩy. Thêm ngoại lệ: dạng động của Thunder `{{#tên}}` hay `{{#tên, đối số đơn giản}}` được giữ cho bước ánh xạ §5.7 (ở vị trí đó `#` không phải JavaScript hợp lệ nên không chạy gì). Mọi cặp khác được **tách dấu ngoặc**: `{{ x }}` thành `{ { x } }`, văn bản thường ở mọi công cụ; `{{` không đóng cũng được tách (httpYac mở một khối mã ở đó có thể nuốt các dòng sau). Lặp tối đa 16 lượt cho ngoặc lồng nhau.

Áp dụng cho URL, tên và giá trị tham số, header (tên và giá trị), body (chữ, form, multipart, GraphQL), đường dẫn tệp đính kèm, giá trị xác thực, giá trị assertion và nguồn capture, và **giá trị biến môi trường**. Báo `TC-EXPRESSION-NEUTRALIZED` (warn) một dòng mỗi collection/môi trường kèm số lượng, không ghi nội dung. Hệ quả có chủ ý: tên biến Thunder có dấu chấm (`{{user.name}}`) cũng bị tách, vì httpYac sẽ đọc nó thành thuộc tính chứ không phải biến tên `user.name`, và một chuỗi dạng đó có thể là đường dẫn như `process.env.X`.

### 5.8 Assertion và biến bắt (capture)

`tests[]` tách thành hai nhóm.

**`set-env-var` → `ImpCapture`** `[FILE][DOC]`:

| Trường | Nghĩa |
|---|---|
| `custom` | nguồn: `json.<đường>` (một khóa của body JSON), `text` (cả body), `header.<tên>`, `cookie.<tên>`, chuỗi thường (giá trị hằng), `null` (xóa giá trị), `delete` (xóa biến) |
| `value` | đích: `{{biến}}`, hoặc `{{biến, local}}`, `{{biến, global}}` |
| `action` | luôn `setto` |

Ví dụ thật `[FILE]`: `{type:"set-env-var", custom:"json.access_token", action:"setto", value:"{{access_token}}"}`.

**Các loại khác → `ImpAssertion`**:

| `type` | `target` | `name` | `op` (từ `action`) |
|---|---|---|---|
| `res-code` | status | | `equal`→`==`, `notequal`→`!=`, `<`, `<=`, `>`, `>=` |
| `res-time` | time (ms) | | như trên |
| `res-body` | body | | `equal`, `notequal`, `contains`, `notcontains`, `regex`, `isjson`, `schema` |
| `Content-Type`, `Content-Length`, `Content-Encoding` | header | chính `type` | `equal`, `notequal`, `contains`, `notcontains`, `<`… |
| `custom-header` | header | `custom` | như trên |
| `json-query` | json | `custom` (đường JSON; có tiền tố `json.` hay không `[?]`) | `equal`, `notequal`, `contains`, `notcontains`, `count`, `istype`, `regex`, `<`…, `schema` |

Cặp (`type`, `action`) không nằm trong bảng → bỏ, báo `TC-TEST-UNSUPPORTED` (ghi nguyên cặp, không ghi `value` nếu giống bí mật).

### 5.9 Script, cookie, cài đặt riêng của request

- `preReq.inlineScripts[].script[]` và `postReq…` `[CODE]` là mã JavaScript chạy trong Thunder. **Không chạy, không dịch.** Ghi nguyên văn thành khối chú thích `# [script not imported: pre|post]` và báo `TC-SCRIPT-SKIPPED`. Nếu `preReq.options.skipRequest` bật, báo thêm vì request đó có thể chỉ để chạy script.
- `cookies`, `settings` của request (timeout, follow redirects…) `[?]`: bỏ, báo `TC-SETTINGS-DROPPED` mức info. `[ĐÃ CÀI: src/convert/request.ts]` Chỉ tính request có `cookies` không rỗng hoặc `settings` có khóa; báo gộp **một dòng mỗi collection** kèm số request.
- `settings.options.baseUrl`, header, auth, test, script ở cấp collection và thư mục **được kế thừa** `[CODE]`: xử lý ở N15–N19, làm phẳng vào từng request. (Bản nháp 1 ghi sai rằng `baseUrl` chỉ thành một biến tệp; thực tế nó là **tiền tố** của URL tương đối.)
- `settings.envId` `[CODE]` (môi trường gắn với collection): ghi nhận trong báo cáo, không tác động file. `settings.runOptions` (cấu hình chạy cả collection): bỏ, báo `TC-SETTINGS-DROPPED`. `[ĐÃ CÀI: src/convert/index.ts]` Cả hai báo cùng một mã, ở collection và ở từng thư mục có chúng, chỉ ghi **tên** cài đặt (`envId`, `runOptions`), không ghi giá trị.

## 6. Phát ra: định dạng E1

### 6.0 Quyết định đã chốt (kèm lý do)

**D1. Định dạng nền: file `.http`**, phần request chỉ dùng **giao điểm** của REST Client, JetBrains HTTP Client và httpYac (dòng request, header, dòng trống, body, `###`, `{{biến}}`, `< tệp`); tệp môi trường kiểu JetBrains (`http-client.env.json`, `http-client.private.env.json`).

Lý do:

- Hai nhóm người dùng cần kéo về nhiều nhất đều đã quen `.http`: REST Client (7,7M lượt cài, 4,9★, bản trên Marketplace không cập nhật từ 08/2022) và người rời Thunder Client. Không bắt họ học định dạng mới.
- `.http` là mẫu số chung lớn nhất (REST Client, JetBrains, Visual Studio, httpYac, nhiều plugin editor khác). Diff trong Git đọc được.
- httpYac đọc `http-client.env.json` và `http-client.private.env.json` (tài liệu của họ nhắc hai tệp này) nên tệp môi trường kiểu JetBrains dùng được ở hơn một công cụ.

**D3. Siêu dữ liệu từng request là chỉ thị trong chú thích, khai báo (declarative), từ vựng mượn của httpYac:**

```
# @assert status == 200
# @assert header content-type == application/json
# @assert duration < 500
# @assert body includes token
# @assert json $.items exists
# @capture access_token = json $.access_token
```

Lý do:

- **Chú thích thì mọi công cụ bỏ qua** → tệp vẫn chạy được ở REST Client, JetBrains, httpYac. Dòng assertion kiểu httpYac (`?? status == 200`) thì REST Client và JetBrains hiểu là **một phần của body**, làm hỏng request.
- **Khai báo, không có JavaScript.** Script kiểu JetBrains (`> {% client.global.set(…) %}`, ES5.1) hay httpYac (`{{ $global.x = … }}`) buộc runtime phải có bộ chạy JS, thêm bề mặt tấn công và phức tạp; trái với tinh thần cục bộ, an toàn của dự án. `set-env-var` của Thunder vốn là khai báo, nên chuyển được sang `@capture` nguyên nghĩa.
- **Toán tử lấy y nguyên của httpYac** (`==`, `!=`, `<`, `<=`, `>`, `>=`, `includes`, `startsWith`, `endsWith`, `matches`, `exists`, `isArray`…): sau này viết bộ xuất sang cú pháp httpYac chỉ là đổi `# @assert X` thành `?? X`.
- Đây là **phần duy nhất ta tự đặt**; công bố ngữ pháp mở để công cụ khác dùng lại được.

**D2. Kế thừa của Thunder được làm phẳng khi import** (mỗi request mang header, auth, baseUrl, test hiệu lực của nó; N15–N19). `.http` không có cơ chế kế thừa, và làm phẳng là cách duy nhất giữ **đúng hành vi** mà không phát minh cấu trúc mới. Cái giá là lặp dòng (50 request cùng một header `Authorization` thì lặp 50 lần); runtime sau này có thể có "mặc định theo thư mục" như tính năng riêng, **không** thuộc bản đầu.

Phương án đã cân và loại (ở bản đầu):

| Phương án | Vì sao không chọn |
|---|---|
| Dòng assertion httpYac (`?? …`) và script `{{ … }}` | Làm hỏng request ở REST Client/JetBrains; captures cần JavaScript |
| Script JetBrains `> {% … %}` | JS ES5.1; trái nguyên tắc khai báo |
| **Hurl** (`.hurl`: `[Captures]`, `[Asserts]`) | Khai báo, CLI trưởng thành, cú pháp rất tốt, nhưng khác loại tệp: mất cả nhóm người dùng `.http`. Có thể thành **đích xuất** sau này |
| **OpenCollection YAML của Bruno** | Mô hình kế thừa giống hệt Thunder (collection → thư mục → request) nên chuyển không cần làm phẳng, và Bruno là nơi nhiều người Thunder đang chuyển tới. Nhưng đặc tả còn mới (bản xem trước đầu 2026), do Bruno quản, và ta sẽ đối đầu trực diện với ứng dụng và extension của chính Bruno; người dùng `.http` không được lợi gì. Có thể thành đích xuất sau này |
| Tự đặt định dạng riêng | Không có lợi thế so với bốn phương án trên, thêm gánh nặng tài liệu và công cụ |

Mọi quyết định có thể đổi bằng cách viết emitter khác: reader, normalize và IR (§4) không đổi.

### 6.1 Bố cục tệp

```
<thư mục đích>/                      mặc định `api/`
  <collection>/                      slug của colName
    index.http                       request ở gốc collection
    <thư mục>.http                   request của một thư mục
    <thư mục>/                       thư mục con của thư mục đó
      <thư mục con>.http
  http-client.env.json               môi trường dùng chung và có tên
  http-client.private.env.json       bí mật và môi trường cục bộ (không vào Git)
  IMPORT_REPORT.md                   báo cáo chuyển đổi
```

Quy tắc tên (`slug`):

- Chuẩn hóa Unicode NFC. Thay `<>:"/\|?*` và ký tự điều khiển bằng `-`. Rút `..` thành `-`. Gộp các `-` liên tiếp. Cắt dấu chấm và khoảng trắng ở hai đầu.
- Ký tự đổi hướng chữ (U+202A–U+202E, U+2066–U+2069, dấu hướng U+200E/U+200F) ký tự rộng bằng không (U+200B–U+200D, U+FEFF) và dấu ngắt dòng, ngắt đoạn của Unicode (U+2028, U+2029; không công cụ nào coi chúng là xuống dòng, nhưng trình soạn thảo có thể hiện chúng như xuống dòng, làm người duyệt tệp tưởng có thêm một dòng) cũng bị thay bằng `-`: chúng có thể đảo thứ tự hiển thị hoặc ẩn một phần tên. Cũng bị thay: các ký tự không vẽ gì nhưng có thể giấu chữ trong tên hoặc làm một tên trông giống tên khác (U+00AD, U+034F, U+061C, U+115F–U+1160, U+3164, U+FFA0, U+180E, U+2060–U+2064, U+206A–U+206F, U+FFF9–U+FFFB và khối ký tự "tag" U+E0000–U+E007F). Bộ chọn biến thể U+FE0F không nằm trong danh sách, để emoji trong tên vẫn nguyên.
- Tên dành riêng của Windows (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1`–`COM9`, `LPT1`–`LPT9` kể cả chữ số mũ): Windows coi tệp là dành riêng theo phần **trước dấu chấm đầu tiên** (`aux.txt` cũng bị), nên thêm `_` **ngay sau phần đó** (`aux.txt` → `aux_.txt`, `CON` → `CON_`).
- Dài tối đa 60 ký tự (cắt theo điểm mã, không cắt giữa ký tự). Rỗng, hoặc chỉ còn dấu `-` do làm sạch (`..`, `/`, `---`) → `unnamed`.
- Trùng nhau **không phân biệt hoa thường** → thêm `-2`, `-3` theo thứ tự đã sắp (N5). Mọi thay đổi tên báo `TC-NAME-SANITIZED` hoặc `TC-NAME-COLLISION`.
- Slug **không bắt đầu bằng `-`** (shell đọc `-x` như một tùy chọn; `../x` thành `x` hữu ích hơn `-x`). `[ĐÃ CÀI]`

Tên chiếm chỗ và tên dành riêng `[ĐÃ CÀI: src/emit/index.ts, names.ts]`:

- Một thư mục chiếm **hai** tên trong thư mục cha: `<slug>/` và `<slug>.http`. Hai thư mục không được trùng ở tên nào (không phân biệt hoa thường), nên thư mục tên `x.http` khi đã có `x` thành `x.http-2`.
- Trong thư mục của collection, `index.http` và `_bodies` bị dành riêng (một thư mục tên `index` thành `index-2`). Ở gốc thư mục đích, `http-client.env.json`, `http-client.private.env.json` và `IMPORT_REPORT.md` bị dành riêng cho các collection.
- Thư mục (hay collection) có `docs` thì tệp của nó mở đầu bằng các dòng chú thích của docs; thư mục chỉ có docs mà không có request vẫn có tệp riêng (chỉ chú thích). Thư mục không request, không docs: không tạo tệp.
- `# @name` chỉ có chữ ASCII, số và `_` (REST Client đọc `\w+`): bỏ dấu, `Đ`/`đ` thành `D`/`d`, ký tự khác thành `_`, rỗng thành `request`; trùng (không phân biệt hoa thường) trong **cùng một tệp** thì thêm `_2`, `_3`.
- Body có dòng mà một công cụ sẽ đọc thành thứ khác ngoài chữ của body (dòng bắt đầu bằng `#` hoặc `//`: `###` là dấu tách request, còn lại là chú thích; dòng `< đường-dẫn` là đọc tệp, dòng `<>`, `> …`, `>> …`, `> {% … %}` là chạy bộ xử lý phản hồi) được lưu ở `<collection>/_bodies/body-0001.txt` (số tăng theo thứ tự duyệt), nội dung đúng từng byte của body, và request đọc nó bằng `< ./_bodies/body-0001.txt` (`../` lặp theo độ sâu của tệp `.http` trong collection). Dòng XML như `<root>` hay `</a>` không bị coi là rủi ro. Với body **multipart**, chỉ phần chữ có dòng như vậy được tách (`< ./_bodies/…` làm nội dung của phần đó); khung multipart và phần đính kèm tệp ở nguyên chỗ. Nếu phần tách ra có `{{biến}}`, request có thêm một dòng ghi chú: một số công cụ không thay biến bên trong tệp. `[ĐÃ CÀI; REST Client đã thử thật]`
- Tệp đính kèm có đường dẫn tương đối được viết `./đường/dẫn` với `/`; đường dẫn tuyệt đối (`C:\…`, `/…`, `~`) giữ nguyên và báo `TC-FILE-PATH`.

### 6.2 Khối request

```
### <tên request>
# @name <slug-duy-nhất-trong-tệp>
# <docs…>
# @capture access_token = json $.access_token
# @assert status == 200
# [disabled] X-Debug: 1
POST {{baseUrl}}/auth/oauth2/{{rdp_version_auth}}/token
Content-Type: application/x-www-form-urlencoded

username={{user}}&grant_type=password
```

- Phân cách giữa các request: một dòng `###` kèm tên.
- Dòng `# @capture` và `# @assert` theo D3 (§6.0, ngữ pháp ở §6.2a). Công cụ khác coi chúng là chú thích nên vô hại.
- Thứ tự dòng trong khối cố định: tiêu đề, `@name`, docs, `@capture`, `@assert`, các dòng `[disabled]`, dòng request, header, dòng trống, body.
- Request bị bỏ (`ws`, `sse`, `grpc`) **không** xuất hiện trong file; chỉ có trong báo cáo.
- Tên header chỉ giữ ký tự của `token` HTTP (RFC 9110: chữ, số và ``!#$%&'*+-.^_`|~``); ký tự khác thành `-`, và `#` ở đầu thành `_`, để không tên nào trông giống chú thích (`#`, `//`), định nghĩa biến tệp (`@x=1`) hay một header thứ hai. `{{biến}}` trong tên được giữ. `[ĐÃ CÀI]`
- Header `Authorization` do xác thực sinh ra: `Bearer <token>`, hoặc `Basic <user> <mật-khẩu>` **cách nhau bằng dấu cách**, chưa mã hóa base64. `[ĐÃ THỬ THẬT: REST Client, httpYac và JetBrains đều mã hóa đúng dạng này (§10.3b, c, d)]` Dạng `Basic user:mật-khẩu` của bản nháp trước **chỉ REST Client mã hóa**; JetBrains gửi nguyên văn, và gửi sai (`admin::mật-khẩu`) khi sau dấu hai chấm là một `{{biến}}`. Dạng có dấu hai chấm chỉ còn dùng cho tên người dùng có khoảng trắng (dạng cách nhau bằng dấu cách không nói được), kèm một dòng ghi chú.
- Dòng chú thích tự do (docs, ghi chú, script) luôn là **một dòng chú thích**: xuống dòng bị thay bằng dấu cách, và nếu nội dung bắt đầu bằng `@` thì thêm `- ` ở đầu để không bao giờ giống một chỉ thị. Script chưa nhập là khối `# [script not imported: pre|post(, from <tầng>)]` rồi từng dòng `# | <dòng>`. `[ĐÃ CÀI: src/emit/http.ts]`

### 6.2a Ngữ pháp chỉ thị (D3)

```
# @assert <chủ thể> <toán tử> [<giá trị>]
# @capture [<phạm vi>:]<biến> = <nguồn>
```

- **Chủ thể** (`<chủ thể>`): `status`, `duration` (ms), `header <tên>`, `body`, `json <JSONPath>`.
- **Toán tử:** `==`, `!=`, `<`, `<=`, `>`, `>=`, `includes`, `startsWith`, `endsWith`, `matches`, `exists`, `isNumber`, `isString`, `isBoolean`, `isArray`: tên và nghĩa **y như httpYac** `[DOC]`. Hai toán tử ta thêm (không có ở httpYac, đánh dấu `*`): `excludes*` (phủ định của `includes`), `isJson*` (body là JSON hợp lệ). `count*` dùng dạng `json $.x count == 3`.
- **Giá trị** là phần còn lại của dòng, bỏ khoảng trắng hai đầu; có thể chứa `{{biến}}`.
- **Nguồn của capture:** `json <JSONPath>`, `body`, `header <tên>`, `cookie <tên>`, `value <hằng>`, `null`, `delete`. **Phạm vi** (tùy chọn): `active` (mặc định), `local`, `global`, ứng với hậu tố `{{biến, local}}` của Thunder.
- Mọi chỉ thị ngoài ngữ pháp này, hoặc dòng `# @…` lạ, runtime phải bỏ qua kèm cảnh báo, không bao giờ coi là mã.

Chuyển từ Thunder:

| Thunder | Chỉ thị |
|---|---|
| `res-code` + `equal`/`notequal`/`<`/`<=`/`>`/`>=` | `# @assert status == 200` |
| `res-time` + so sánh | `# @assert duration < 500` |
| `res-body` + `equal`/`notequal`/`contains`/`notcontains`/`regex`/`isjson` | `body ==`, `!=`, `includes`, `excludes*`, `matches`, `isJson*` |
| `Content-Type`/`Content-Length`/`Content-Encoding`, `custom-header` | `# @assert header <tên> <toán tử> <giá trị>` (`contains` → `includes`, `notcontains` → `excludes*`) |
| `json-query` + `equal`/`notequal`/`contains`/`notcontains`/`regex`/so sánh | `# @assert json <JSONPath> <toán tử> <giá trị>` |
| `json-query` + `count` | `# @assert json <JSONPath> count == <giá trị>*` |
| `json-query` + `istype` | `isNumber`/`isString`/`isBoolean`/`isArray` theo giá trị; loại khác `[?]` → `TC-TEST-UNSUPPORTED` |
| `schema` (bất kỳ loại) | bản đầu **không hỗ trợ**: `TC-TEST-UNSUPPORTED` |
| `set-env-var` + `setto` | `# @capture <biến> = <nguồn>` (nguồn `json.x` → `json $.x`; `text` → `body`; `header.x` → `header x`; `cookie.x` → `cookie x`; hằng → `value …`) |

Đường JSON của Thunder (`json.data.items[0].id`) → JSONPath: bỏ tiền tố `json.`, thêm `$.` (`$.data.items[0].id`); phần còn lại rỗng thì chỉ `$`. Thiếu tiền tố `json.` `[?]` → coi như đã bỏ, báo `TC-JSONPATH-GUESS`. Khóa có ký tự đặc biệt: cú pháp của Thunder `[?]`; khi chuyển sang JSONPath dùng ký hiệu ngoặc `['khóa']`.

### 6.3 Xác định (determinism)

- Kết thúc dòng `\n`; mỗi file kết thúc bằng đúng một `\n`; không có dấu thời gian, không có đường dẫn tuyệt đối, không có ngày xuất.
- Cùng đầu vào (kể cả mảng bị xáo thứ tự) → cùng từng byte đầu ra.
- Khóa JSON của tệp môi trường sắp theo thứ tự chữ cái (điểm mã), thụt 2 dấu cách.

### 6.4 Chính sách ghi

- Không ghi vào thư mục không rỗng đã tồn tại trừ khi người dùng chọn rõ: `bỏ qua tệp đã có`, `ghi đè`, `ghi vào thư mục mới có hậu tố`. Mặc định là thư mục mới.
- Ghi theo kiểu tạm rồi đổi tên (staging directory, `rename`), hủy giữa chừng không để lại nửa vời.
- Nếu `http-client.private.env.json` được tạo: quyền `0600` khi hệ điều hành hỗ trợ, **và** thêm dòng `http-client.private.env.json` vào `.gitignore` của gốc workspace (tạo nếu chưa có, không trùng). Việc này hiện trong bản xem trước. Với đích REST Client còn thêm `rest-client.private.settings.json` (cùng quyền, cùng cách) vào `.gitignore`; chỉ những tệp riêng tư thật sự được ghi mới có dòng trong `.gitignore`, và dòng đã có (kể cả dạng `/tên`, `**/tên`) không thêm lần nữa. `[ĐÃ CÀI: src/write/gitignore.ts]`

Chi tiết đã cài `[ĐÃ CÀI: src/write/]`:

- Hai bước: `planWrite` (chỉ đọc đĩa, trả kế hoạch: thư mục cuối cùng, hành động `create`/`overwrite`/`skip` cho từng tệp, thay đổi `.gitignore`) rồi `writeFiles`, **lập lại kế hoạch ngay trước khi ghi** vì đĩa có thể đã đổi sau bản xem trước.
- Staging là thư mục `.api-import-XXXXXX` ngay trong gốc workspace (cùng ổ đĩa để đổi tên được); tệp được ghi ở đó trước, rồi chuyển vào chỗ cuối. `new-folder`: một lần đổi tên cả thư mục; `skip-existing`/`overwrite`: chuyển từng tệp, tệp bị thay được cất vào `previous/` để hoàn tác.
- Lỗi hay hủy giữa chừng: hoàn tác mọi thứ đã chuyển, xóa thư mục cha đã tạo, trả `.gitignore` về như cũ (xóa nếu do ta tạo), xóa staging. Hủy được kiểm tra trước khi bắt đầu chuyển.
- `.gitignore` được cập nhật **trước** khi tệp riêng tư xuất hiện. Nếu `.gitignore` là liên kết hoặc không phải tệp thường: từ chối ghi cả lần (không để tệp bí mật không được bảo vệ).
- Mọi thành phần của đường dẫn đích được `lstat`: **không đi qua symlink/junction** (`unsafe-path`), thứ không phải thư mục nằm chắn đường là `exists`. Đường dẫn bị từ chối trước khi ghi gì: rỗng, tuyệt đối, có `..` hoặc `.`, ký tự `<>:"/\|?*`, ký tự ẩn hoặc đổi hướng, kết thúc bằng dấu chấm/khoảng trắng, tên dành riêng của Windows, hai tệp trùng đường dẫn (không phân biệt hoa thường).
- Chế độ `0600` không có nghĩa trên Windows; ở đó tệp riêng tư dựa vào `.gitignore` và vị trí.

### 6.5 Môi trường

**Không dùng khóa `$shared`.** Tài liệu của httpYac chỉ nói `$shared` cho cấu hình `.httpyac.js`, không nói cho `http-client.env.json`; trang JetBrains đã xem cũng không nhắc. Thay vào đó **làm phẳng**: biến dùng chung được chép vào từng môi trường có tên (môi trường có tên ghi đè khi trùng tên biến). Cách này đúng ở mọi công cụ.

| Nguồn (N14) | Phát ra |
|---|---|
| môi trường có tên | khóa `<name>` trong `http-client.env.json`; gồm biến dùng chung chưa bị ghi đè |
| `global` không `local` (dùng chung) | không có khóa riêng; chép vào mọi môi trường có tên. Nếu **không có** môi trường có tên nào → một môi trường tên `default` |
| `global` và `local` (cục bộ) | cùng quy tắc nhưng vào `http-client.private.env.json` |
| biến bí mật của môi trường có tên (§8.3) | giá trị trong `http-client.private.env.json` cùng khóa môi trường |
| `default: true` | ghi vào báo cáo "môi trường mặc định: X"; không có tệp riêng |
| `envFile` | không đọc tệp dotenv; báo `TC-ENV-FILE` kèm đường dẫn |

Cả hai tệp có cấu trúc `{ "<môi trường>": { "<biến>": "<giá trị>" } }`, khóa sắp theo thứ tự chữ cái. Giá trị luôn là chuỗi.

Chi tiết đã cài `[ĐÃ CÀI: src/emit/env.ts]`:

- Hai môi trường cùng tên: môi trường sau thành `<tên>-2` (`TC-NAME-COLLISION`), không bao giờ gộp hay mất.
- Mọi biến bí mật, biến mã hóa (giá trị rỗng, `needsReentry`), biến của môi trường cục bộ và các biến `secret_<collection>_<nhãn>` do importer tạo (§8.3) vào tệp riêng tư **dưới mọi môi trường có tên**; tệp riêng tư không được tạo nếu không có biến riêng tư nào.
- Khi chỉ có tệp riêng tư thì tệp chung vẫn có khóa môi trường tương ứng (có thể là `{}`), vì JetBrains ghép hai tệp theo tên môi trường.
- Biến do importer tạo nằm trong một môi trường tổng hợp `Imported secrets` (loại `private`, `synthetic`) ở mô hình trung gian; nó không bao giờ thành một môi trường có tên.

**Đích REST Client** `[ĐÃ CÀI: src/emit/env.ts; đã thử thật trong REST Client 0.25.1]`: REST Client **không đọc `http-client.env.json`**; biến của nó nằm trong cài đặt VS Code `rest-client.environmentVariables`. Với đích `rest-client` (mặc định) importer viết thêm, từ cùng các biến đó và cùng cách tách chung/riêng:

| Tệp | Nội dung | Cách dùng |
|---|---|---|
| `rest-client.settings.json` | `{ "rest-client.environmentVariables": { "<môi trường>": { "<biến>": "<giá trị>" } } }`, chỉ phần dùng chung | dán vào `.vscode/settings.json` của workspace (có thể commit) |
| `rest-client.private.settings.json` (quyền `0600`, vào `.gitignore`) | cùng dạng, chỉ phần riêng tư: bí mật, biến mã hóa (rỗng), biến cục bộ | dán vào **cài đặt người dùng** (Preferences: Open User Settings (JSON)); không commit |

Đã thử thật: đặt tệp thứ nhất ở cài đặt workspace và tệp thứ hai ở cài đặt người dùng của một profile sạch, chọn môi trường `dev` bằng lệnh `Rest Client: Switch Environment`; REST Client **gộp hai phạm vi theo từng môi trường** (biến chung từ workspace, bí mật từ người dùng), và cả 47 request của mẫu chạy với đúng giá trị (Bearer, Basic, khóa trong query, header riêng). Khóa `$shared` của REST Client là khóa dành riêng, nên một môi trường tên `$shared` được đổi thành `$shared-2`. Tệp riêng tư chỉ có khi có biến riêng tư. Báo cáo viết đúng ba bước (dán, dán, chọn môi trường). Các đích khác không nhận hai tệp này (httpYac và JetBrains đọc `http-client.env.json`).

**Tự điền cài đặt (lớp VS Code)** `[ĐÃ CÀI: src/settings-merge.ts, src/host.ts, extension/src/vscodeHost.ts; đã thử thật]`: với đích `rest-client` và công tắc "Fill in the REST Client settings for me" bật (mặc định), sau khi ghi tệp xong, extension thêm các biến vào `rest-client.environmentVariables` bằng API cấu hình của VS Code (sửa `settings.json` tại chỗ, **giữ nguyên chú thích** và các cài đặt khác): phần chung vào cài đặt **workspace**, phần riêng tư (bí mật) vào cài đặt **người dùng**. Quy tắc gộp, từng môi trường:

- môi trường hay biến chưa có thì thêm; có sẵn cùng giá trị thì để nguyên; có sẵn **giá trị khác thì giữ giá trị của người dùng** và nêu tên `môi-trường.biến` trong thông báo cuối (không bao giờ nêu giá trị). Nhập lại lần hai không đổi gì, và hai dự án không ghi đè lên nhau trong cài đặt người dùng;
- những gì người dùng có sẵn (môi trường khác, `$shared`, giá trị kiểu khác) không bị đụng; khóa như `__proto__` của dữ liệu là khóa thường;
- vì cài đặt người dùng có thể được **Settings Sync** đẩy lên tài khoản, và giờ nó chứa bí mật, `rest-client.environmentVariables` được thêm vào `settingsSync.ignoredSettings` (giữ nguyên các mục đã có);
- chỉ làm cho tệp **thật sự được ghi** (chính sách `skip-existing` mà tệp riêng tư đã có thì không ghi bí mật vào cài đặt người dùng);
- bước xác nhận nói rõ việc này, và có công tắc để tắt trong Quick Pick cài đặt;
- nếu REST Client (`humao.rest-client`) chưa cài, cài đặt của nó chưa tồn tại và VS Code từ chối ghi: không ghi gì, thông báo cuối nói cần dán sau khi cài; nếu ghi lỗi thì import vẫn là thành công (tệp đã ghi), thông báo nói dán tay;
- chưa tự chọn môi trường: người dùng vẫn chạy "Rest Client: Switch Environment" (lệnh này mở Quick Pick riêng của REST Client).

Đã thử thật trong VS Code 1.107.1 với REST Client 0.25.1 cài vào profile tạm, cài đặt có sẵn kèm chú thích ở cả hai phạm vi: biến `base` có sẵn khác giá trị được giữ, `extra` của người dùng còn nguyên, `region` mới được thêm, chú thích và cài đặt khác còn nguyên, bí mật chỉ ở cài đặt người dùng, `settingsSync.ignoredSettings` thành `["some.other.setting", "rest-client.environmentVariables"]`. Không có REST Client: không đụng cài đặt nào.

## 7. Báo cáo chuyển đổi

Hai nơi: bản xem trước trước khi ghi, và `IMPORT_REPORT.md` sau khi ghi. **Không chứa giá trị bí mật**, chỉ tên và vị trí.

| Mã | Mức | Ý nghĩa và hành động |
|---|---|---|
| `TC-LAYOUT-BOTH` | warn | có cả v3 và v4, dùng v4 |
| `TC-PARSE-ERROR` | warn/info | file không đọc được hoặc không nhận ra; bỏ file đó |
| `TC-TOO-LARGE` | error | vượt giới hạn (§8); bỏ file |
| `TC-VERSION-UNKNOWN` | info | `version` lạ; vẫn đọc |
| `TC-HISTORY-SKIPPED` | info | số mục lịch sử bị bỏ |
| `TC-ORPHAN-FOLDER`, `TC-ORPHAN-REQUEST`, `TC-CYCLE`, `TC-DEPTH` | warn | cây thư mục hỏng, đã sửa cách an toàn |
| `TC-METHOD-INVALID` | warn | method sai, dùng `GET` |
| `TC-REQTYPE-UNSUPPORTED` | warn | ws/sse/grpc, bỏ request |
| `TC-PARAM-NOT-IN-URL`, `TC-PATHPARAM-EMPTY` | warn | param lệch với url |
| `TC-HEADER-DEFAULT-DROPPED` | info | đã bỏ header mặc định của Thunder |
| `TC-INHERIT-HEADERS`, `TC-INHERIT-AUTH`, `TC-INHERIT-BASEURL`, `TC-INHERIT-TESTS` | info | request đã nhận giá trị kế thừa từ thư mục/collection (kèm nơi lấy, số lượng) |
| `TC-HEADER-DUP` | warn | hai header trùng tên khác hoa thường, giữ cái đến sau |
| `TC-PREREQ-RUN` | warn | cấu hình "chạy request khác trước" không chuyển được |
| `TC-JSONPATH-GUESS` | info | đường JSON thiếu tiền tố `json.`, đã đoán |
| `TC-BODY-UNSUPPORTED`, `TC-GRAPHQL-VARS` | warn | body không chuyển được hoặc variables không phải JSON |
| `TC-FILE-PATH` | warn | tệp đính kèm nằm ngoài repo hoặc đường dẫn tuyệt đối |
| `TC-AUTH-OAUTH2`, `TC-AUTH-UNSUPPORTED`, `TC-AUTH-HEADER-CONFLICT` | warn | xác thực không chuyển hoặc xung đột |
| `TC-TEST-UNSUPPORTED` | warn | assertion không có tương đương |
| `TC-SYSVAR-UNMAPPED` | info | biến hệ thống để nguyên |
| `TC-EXPRESSION-NEUTRALIZED` | warn | chữ giữa `{{ }}` trông như mã hay đường dẫn (không phải tên biến thuần) nên dấu ngoặc đã được tách để không công cụ nào chạy hay đọc nó (§5.7a) |
| `TC-SCRIPT-SKIPPED` | warn | script không chạy, ghi chú giữ lại |
| `TC-SETTINGS-DROPPED` | info | cài đặt request bị bỏ |
| `TC-ENV-ENCRYPTED` | warn | biến mã hóa, cần nhập lại (§8.4) |
| `TC-ENV-FILE`, `TC-ENV-DUP` | info/warn | tham chiếu dotenv, biến trùng tên |
| `TC-SECRET-MOVED` | info | bí mật đã chuyển sang tệp riêng tư (§8.3) |
| `TC-SECRET-LITERAL` | warn | còn bí mật dạng hằng trong tệp chung (khi người dùng tắt chuyển) |
| `TC-NAME-SANITIZED`, `TC-NAME-COLLISION` | info | tên đã đổi để hợp lệ hoặc không trùng |
| `TC-VALUE-COERCED` | info | giá trị sai kiểu đã ép |
| `TC-LINEBREAK-REPLACED` | info | một giá trị một dòng (URL, header, tên, chỉ thị) chứa xuống dòng và đã được thay: file `.http` không bao giờ bị dữ liệu chèn thêm dòng |
| `TC-BODY-EXTERNAL` | info | body (hay một phần chữ của body multipart) có dòng bị công cụ đọc thành thứ khác, xem §6.1, nên được lưu thành tệp riêng và tham chiếu bằng `< ./đường-dẫn`. Lý do an toàn: dữ liệu của một collection do người khác đưa không được phép làm request đọc tệp trên máy bạn (`< tệp`) hay chạy bộ xử lý |

Tóm tắt cuối báo cáo: số collection, thư mục, request nhập được; số bị bỏ theo từng lý do; số bí mật đã chuyển; số biến cần nhập lại.

## 8. An toàn và độ bền

### 8.1 Giới hạn

| Mục | Giới hạn |
|---|---|
| Kích thước một file JSON | 20 MiB |
| Tổng dung lượng đọc | 200 MiB |
| Số file đọc | 5.000 |
| Số request mỗi lần | 50.000 |
| Độ sâu JSON | 64 |
| Độ dài một chuỗi | 5 MiB |
| Độ dài tên (trước khi cắt slug) | 1.000 ký tự |
| Độ sâu thư mục (N6) | 32 |
| Độ dài slug | 60 điểm mã |
| Số mục kế thừa mỗi collection (N15–N19, chống nhân đầu vào nhỏ thành đầu ra khổng lồ) | 2.000.000; chuỗi tổ tiên tối đa 1.024 tầng |
| Tổng đầu ra của emitter | 256 MiB: vượt thì dừng sạch ở một request, giữ tệp môi trường, báo `TC-TOO-LARGE` mức error kèm số request chưa ghi, và báo cáo ghi "nhập chưa đầy đủ" |

Vượt giới hạn → bỏ phần đó, báo `TC-TOO-LARGE`, **không** đổ vỡ cả lần nhập. Mọi con số là điểm xuất phát, chỉnh theo đo đạc.

### 8.2 Đọc file

- Chỉ đọc, `fs.open` với cờ chỉ-đọc. Không bao giờ ghi vào cây nguồn.
- Không đi theo liên kết tượng trưng (symlink) ra ngoài thư mục gốc đã chọn: dùng `lstat`, bỏ mục là symlink hoặc có `realpath` ngoài gốc.
- `JSON.parse` thuần, không `reviver`, không `eval`. Sau khi parse, **không bao giờ gộp** (`Object.assign`, spread) đối tượng nguồn vào đối tượng đích; đọc từng trường đã biết. Khóa `__proto__`, `constructor`, `prototype` bị bỏ qua. Dùng `Map` hoặc đối tượng không prototype cho từ điển trung gian.
- Không thực thi gì từ dữ liệu: không `child_process`, không `require` động, không URL fetch.

### 8.3 Bí mật không được lọt vào Git

Mặc định bật "chuyển bí mật sang tệp riêng tư" (người dùng tắt được trong bản xem trước). Ứng viên bí mật:

- `auth.bearer`, `auth.basic.password`, giá trị `apikey`, **khi là hằng** (không chỉ gồm `{{biến}}`).
- Header có giá trị hằng mà **tên có một từ** (các từ ngăn bởi `-` hoặc `_`) thuộc: `authorization`, `auth`, `token`, `secret`, `password`, `passwd`, `pwd`, `credential(s)`, `cookie`, `session`, `signature`, `apikey`, `key`. `[ĐÃ CÀI: src/convert/secrets.ts]` Bản nháp 2 chỉ có danh sách cố định `authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie`; fixture F10 cho thấy `X-Old-Key` lọt qua. Nhầm một header thường thành bí mật chỉ tốn một biến phải điền, bỏ sót một bí mật thì lộ vào Git, nên chọn nghiêng về bắt thừa.
- Biến môi trường mà tên khớp `/(secret|token|password|passwd|pwd|key|credential|auth)/i`.
- Mọi biến trong môi trường `local` (§6.5) và mọi biến `encrypted`.
- Mở rộng so với bản nháp 2 `[ĐÃ CÀI]`: tham số query và trường form (`formencoded`, phần chữ của `formdata`) mà **tên** khớp quy tắc biến ở trên và giá trị là hằng; header **đã tắt** cũng được bảo vệ (nó vẫn xuất hiện trong tệp dưới dạng chú thích `# [disabled] …`).
- `[ĐÃ CÀI]` **Thân thô**: trong thân JSON, XML, chuỗi truy vấn (`a=b&c=d`) và trong GraphQL, giá trị chuỗi hằng nằm dưới một **tên** khớp quy tắc biến cũng là bí mật: `"apiKey": "…"`, `<Password>…</Password>` (và thuộc tính `apiKey="…"`, bỏ qua tiền tố và khai báo `xmlns`), `client_secret=…`, đối số `password: "…"` của query GraphQL và khóa trong `variables`. Chỉ giá trị được thay bằng `{{secret_<collection>_body_<tên>}}`, phần còn lại của văn bản giữ nguyên; giá trị riêng tư được ghi đúng như đã viết (có cả dấu escape), riêng đối số trong query GraphQL được ghi theo cách JSON viết vì query thành một chuỗi JSON. Văn bản tự do không có tên bên trong thì không quét được: đó là chỗ duy nhất một bí mật còn có thể nằm lại, và `SECURITY.md` nói rõ điều đó. Mỗi bộ quét chỉ đi qua văn bản một lần (test đưa 1 MiB dữ liệu xấu vào từng bộ).
- `[ĐÃ CÀI]` **URL ngoài query**: mật khẩu trước `@` (`https://user:MẬT-KHẨU@host`; userinfo không có `:` coi là token và được bảo vệ cả), tham số đường dẫn `:tên` có tên khớp quy tắc biến (giá trị được bảo vệ trước khi vào đường dẫn), và các cặp `tên=giá trị` trong fragment (cách OAuth redirect mang token: `#access_token=…`). Tên người dùng của cặp `user:password` không phải bí mật.
- Bảo vệ theo giá trị: cùng một giá trị trong cùng một collection là **một** biến (`secret_<collection>_<nhãn>`, giá trị khác thì thêm `_2`, `_3`); `Bearer abc` tách thành từ chỉ cách thức (`Bearer `) và thông tin xác thực. Giá trị chỉ gồm `{{biến}}` không phải bí mật.
- Không bao giờ ghi giá trị của xác thực không hỗ trợ (OAuth 2.0, AWS, digest, NTLM): ghi chú chỉ có **tên khóa** (`[auth oauth2 not imported; settings: clientSecret, grantType]`).

Cách chuyển: thay giá trị bằng `{{<tên-an-toàn>}}` trong tệp chung, đặt giá trị thật trong `http-client.private.env.json`. Báo từng mục `TC-SECRET-MOVED`. Test dùng **chuỗi canary** để chứng minh không còn bí mật nào lọt vào tệp chung (§10).

Nhật ký, bản xem trước, báo cáo, thông báo lỗi: chỉ in **tên** và vị trí, không bao giờ in giá trị đã đọc.

### 8.4 Biến môi trường mã hóa

`[CODE]` Giá trị có `encrypted: true` được mã hóa bằng AES-256-CBC với khóa nằm sẵn trong gói của Thunder; Thunder còn xóa trắng chúng khi gói không trả phí.

Quy tắc: **không giải mã**. Biến đó được nhập với giá trị rỗng, `needsReentry = true`, báo `TC-ENV-ENCRYPTED`, và tên biến vẫn có trong tệp riêng tư để người dùng điền.

Lý do: khóa thuộc cơ chế cấp phép của họ, dùng nó là vượt qua một biện pháp bảo vệ; và importer cũng không cần giá trị đó để hữu ích.

### 8.5 Quyền riêng tư của lần quét

- Bản xem trước ban đầu chỉ cần **tên** collection/request và các con số.
- Chỉ đọc nội dung đầy đủ sau khi người dùng bấm tiếp tục.
- Không sao chép dữ liệu nguồn đi đâu khác ngoài thư mục đích đã chọn.

## 9. Luồng người dùng

Hai lệnh, cùng một luồng: **HTTP Files Importer: Import from Thunder Client…** mở **panel** (một webview, bên dưới), và **Import from Thunder Client (step by step)…** hỏi từng bước bằng Quick Pick (cho người dùng bàn phím, và là cách test cũ). Ngoài ra có một mục trong Explorer ("HTTP Files Importer", thu gọn sẵn, chỉ hiện khi đã mở thư mục) với nút mở panel. Không dùng hộp thoại modal (môi trường test của VS Code từ chối chúng). Mục dưới đây mô tả các bước của luồng Quick Pick; panel làm đúng những bước đó trên một màn hình.

`[ĐÃ CÀI]` **Panel** (`src/wizard/`, `extension/src/wizardPanel.ts`, `extension/src/webview/main.ts`): bốn khối cuộn được: (1) nguồn: các thư mục gợi ý kèm số liệu, "Chọn thư mục…", "Chọn tệp xuất…", đang đọc thì có nút Hủy; (2) kết quả đọc: số collection, request, môi trường, bí mật đã chuyển, request không nhập được, giá trị phải nhập lại, các phát hiện nhóm theo mức (cần chú ý / chi tiết) và nút mở báo cáo đầy đủ; (3) cách ghi: công cụ đích (thẻ), thư mục trong workspace (kiểm tra ngay khi gõ), chính sách khi thư mục đã có tệp, hai công tắc (chuyển bí mật, điền cài đặt REST Client); (4) sẽ ghi gì (số tệp, danh sách, `.gitignore`), cùng một thanh ở đáy cửa sổ luôn thấy được với nút **Import N files**. Đổi công cụ đích hay công tắc bí mật thì đọc lại dữ liệu; đổi thư mục hay chính sách chỉ lập kế hoạch lại. Xong thì hiện kết quả với nút Mở thư mục / Mở báo cáo / Nhập tiếp. Không có gì được ghi trước khi bấm Import.

`[ĐÃ CÀI]` Trạng thái và mọi quy tắc nằm ở `WizardSession` (`src/wizard/session.ts`, test không cần VS Code); panel chỉ vẽ `WizardView` (chỉ tên, số, thông báo do importer viết, không bao giờ giá trị đọc từ dữ liệu) và chuyển lựa chọn của người dùng. Thông điệp từ trang được coi là không đáng tin: `parseToHost` chỉ nhận đúng các dạng đã biết, không có đường dẫn nào đến từ trang (thư mục và tệp do hộp thoại của VS Code chọn, gợi ý được gọi bằng số thứ tự). Trang có CSP `default-src 'none'`, một script duy nhất mang nonce, không script/kiểu nội tuyến; nội dung từ collection chỉ vào trang bằng `textContent` (một test cấm `innerHTML` và các API tương tự). Webview chỉ nạp `dist/` và `media/` của extension, không giữ trang khi ẩn, không bật lệnh URI.

`[ĐÃ CÀI]` **Import chỉ ghi đúng kế hoạch đã hiển thị**: ngay trước khi ghi, `write()` lập kế hoạch lại và chỉ ghi nếu kế hoạch giống hệt cái người dùng đang thấy (thư mục đã đổi, cửa sổ khác mở workspace khác); nếu khác thì không ghi gì, cập nhật kế hoạch và báo "nhấn Import lại". Các kế hoạch chồng nhau được đánh số, kế hoạch về muộn không đè kế hoạch mới. Đọc lại thất bại thì các lựa chọn trở về những cái màn hình đang hiển thị đã được đọc bằng. Khi đang ghi thì không thể "Start over", đọc nguồn khác hay đổi lựa chọn. Đóng panel không làm hỏng lệnh: panel được quên trước, rồi mới dọn.

`[ĐÃ CÀI]` **Cài đặt REST Client chỉ được điền khi bí mật đã được chuyển** (cả ở panel lẫn luồng từng bước): nếu tắt chuyển bí mật thì một bí mật dạng hằng sẽ bị ghi cả vào cài đặt workspace, và cài đặt đó hay được commit.

1. **Chọn nguồn** (Quick Pick): các thư mục gợi ý (§2.4) kèm số liệu, mục "Chọn thư mục…", mục "Chọn tệp xuất…".
2. **Quét** (tiến trình, hủy được): đọc, chuẩn hóa, sinh IR và báo cáo trong bộ nhớ.
3. **Xem trước**: mở `IMPORT_REPORT.md` dạng tài liệu chỉ-đọc (cây collection, số liệu, các cảnh báo nhóm theo mã). Có ba công tắc trong Quick Pick tiếp theo: thư mục đích (mặc định `api/`), "chuyển bí mật sang tệp riêng tư" (bật), chính sách khi tệp đã có. `[ĐÃ CÀI: extension/src/vscodeHost.ts]` Là một Quick Pick lặp: "Continue", "Target folder: api", "Written for: REST Client" (công cụ đích, chọn để đổi vòng tròn: REST Client, httpYac, JetBrains HTTP Client), "Move secrets…: yes/no", chính sách (chọn để đổi vòng tròn); đổi công tắc bí mật hoặc công cụ đích thì quét và báo cáo lại.
4. **Xác nhận** bằng một mục Quick Pick ghi rõ "Ghi N tệp vào `<thư mục>`".
5. **Ghi** theo §6.4, rồi thông báo "Đã nhập X request. Mở thư mục / Mở báo cáo".

Lệnh không bao giờ tự chạy, và không có thông báo đề nghị nhập.

`[ĐÃ CÀI]` Luồng nằm ở `src/host.ts` sau giao diện `ImportHost` (mọi câu hỏi và thông báo), kiểm bằng host giả; `extension/` chỉ trả lời các câu hỏi bằng API của VS Code. Extension khai báo `untrustedWorkspaces: false` (ghi tệp và đọc thư mục ngoài workspace) và `virtualWorkspaces: false` (ghi bằng hệ tệp của máy chạy extension), không có `activationEvents` (chỉ chạy khi gọi lệnh), không mạng. Gợi ý thư mục (§2.4) do `src/discover.ts` làm, chỉ đọc **tên** tệp. Dòng lệnh `dist/cli.js` (`thunder-import <nguồn>… [--write] [--out] [--workspace] [--policy] [--no-move-secrets] [--target rest-client|httpyac|jetbrains]`) mặc định chạy thử (in báo cáo và danh sách tệp, không ghi gì).

## 10. Kế hoạch kiểm thử

Kiểu Git Pro: test đơn vị `node:test` cho core thuần; test tích hợp trên cây tệp thật trong thư mục tạm; không phụ thuộc mạng.

### 10.1 Bộ fixture

| Mã | Nội dung | Nguồn |
|---|---|---|
| F1 | Xuất collection thật (7 request, 4 thư mục, `set-env-var`, `bearer`, `formencoded`, query trong url) | `[FILE]` LSEG (tải lại khi cần; giữ bản sao nhỏ trong repo kèm giấy phép của repo nguồn, hoặc tự dựng cùng hình dạng) |
| F2 | v3: `thunderclient.json` + `thunderCollection.json` + `thunderEnvironment.json` | dựng theo `[FIXT]` và `[CODE]` |
| F3 | v4: `collections/tc_col_orders.json` có path param, `formencoded`, `basic`, `formdata` kèm tệp | `[FIXT]` |
| F4 | Môi trường v4 có `encrypted`, `global`, `local`, `default`, `envFile` | dựng theo `[CODE]` |
| F5 | `body.raw` là mảng dòng so với chuỗi → cùng đầu ra | dựng |
| F6 | `docs` là mảng và chuỗi | dựng |
| F7 | Tên xấu: `../x`, `CON`, `aux.txt`, dấu chấm cuối, emoji, 500 ký tự, trùng khác hoa thường | dựng |
| F8 | Cây hỏng: chu trình, cha thiếu, `colId` lạ, mục `colId == "history"` | dựng |
| F9 | Không hỗ trợ: `reqType` `ws`/`sse`/`grpc`, auth `digest`/`aws`/`ntlm`/`oauth2`, body `binary` | dựng |
| F10 | Bí mật: bearer hằng, mật khẩu basic, header `Authorization`, biến `api_token`, biến `encrypted` | dựng với chuỗi canary |
| F11 | Độc hại: khóa `__proto__`/`constructor`, mảng khổng lồ, lồng sâu, BOM, UTF-8 sai, symlink ra ngoài, chuỗi 10 MiB | dựng |
| F12 | Xác định: cùng dữ liệu, mảng xáo trộn, `sortNum` trùng | dựng |
| F13 | **Kế thừa:** chuỗi 3 tầng (collection → thư mục A → thư mục con B) có `settings.headers`, `settings.auth` (`inherit`/`none`/bearer), `options.baseUrl` ở nhiều tầng, test trùng và không trùng, request ghi đè header và auth; URL tuyệt đối, URL bắt đầu bằng `{{`, URL tương đối | dựng theo `[CODE]` |

### 10.2 Thuộc tính cần chứng minh

- P1. **Xác định**: `import(x)` hai lần, và `import(shuffle(x))`, cho đúng các byte giống nhau.
- P2. **Không ném lỗi**: mọi JSON đầu vào (kể cả sinh ngẫu nhiên) cho ra báo cáo, không bao giờ ném.
- P3. **Không thoát thư mục đích**: không đường dẫn đầu ra nào có `..`, tuyệt đối, hoặc thoát khỏi thư mục đích sau khi chuẩn hóa.
- P4. **Không rò bí mật**: với F10, không chuỗi canary nào xuất hiện trong tệp chung, báo cáo hay nhật ký; chúng chỉ ở trong tệp riêng tư.
- P5. **Khứ hồi**: tệp `.http` phát ra, qua bộ phân tích của extension mới (khi có), cho lại cùng method, url, header, body với IR.
- P6. **Không đụng nguồn**: băm cây nguồn trước và sau, phải giống nhau; tệp nguồn mở chỉ-đọc.
- P7. **Đóng gói gọn**: 5.000 request chuyển đổi trong lõi dưới 1 giây (ngưỡng đo lại).
- P8. **Kế thừa đúng thuật toán Thunder**: cài lại N15–N19 một cách độc lập như **hàm tham chiếu** viết thẳng theo mô tả §5.1 (cố ý đơn giản, không tối ưu), rồi so với bộ chuyển đổi trên F13 và trên cây ngẫu nhiên (độ sâu, số header, auth, baseUrl ngẫu nhiên): kết quả phải y hệt.

### 10.3 Tiêu chí chấp nhận

- F1, F2, F3: 100% request có `method`, `url`, header, body `json`/`formencoded`/`formdata`, auth `bearer`/`basic` được nhập không mất thông tin; `set-env-var` thành capture đúng.
- F9: mỗi mục không hỗ trợ có đúng một finding và **không** có trong file.
- F10: 0 canary rò.
- P1 đến P6 đều xanh.
- Có test kiểm tra danh sách mã trong §7 khớp mã trong mã nguồn (mỗi mã dùng ít nhất một lần, không mã mồ côi), như test manifest của Git Pro.

### 10.3a Trạng thái cài đặt (2026-10-20)

Fixture dựng trong bộ nhớ ở `test/fixtures/cases.ts`; kết quả mong đợi từng byte ở `test/fixtures/golden/<mã>/` (kèm `findings.txt`), được **đọc bằng mắt** trước khi chấp nhận; ghi lại bằng `UPDATE_GOLDEN=1 npm test` rồi đọc diff.

| Mã | Trạng thái |
|---|---|
| F1 | golden (`f01-export`); dựng cùng hình dạng, **không chép** dữ liệu của repo LSEG |
| F2 | golden (`f02-v3`, trong bộ nhớ) và `fixtures-more.test.ts` (trên đĩa, qua reader, kiểm nguồn không đổi) |
| F3, F4, F7, F9, F10, F13 | golden |
| F5, F6 | `fixtures-more.test.ts`: mảng dòng và chuỗi cho cùng đầu ra |
| F8 | golden (`f08-broken`) |
| F11 | `fixtures-more.test.ts` trên đĩa: BOM, `__proto__`/`constructor`, UTF-8 sai, lồng sâu, chuỗi 6 MiB, symlink ra ngoài |
| F12 | `fixtures-more.test.ts`: 30 lần xáo, `sortNum` và tên trùng |

| Thuộc tính | Cách kiểm |
|---|---|
| P1 xác định | xáo thứ tự tệp, khóa và các mảng không có thứ tự (30 lần) → cùng từng byte |
| P2 không ném lỗi | 400 mẫu ngẫu nhiên có rác ở mọi trường của request, thư mục, môi trường, và các tệp v3 |
| P3 không thoát thư mục | mọi đường dẫn đầu ra của mọi fixture và mẫu ngẫu nhiên đi qua cùng bộ kiểm của bộ ghi |
| P4 không rò bí mật | 9 chuỗi canary ở mọi chỗ có thể (bearer, basic, header, header tắt, query, form, biến, biến cục bộ); chỉ ở tệp riêng tư; cả khi tắt chuyển (khi đó mỗi cái được báo `TC-SECRET-LITERAL`, không có giá trị nào trong báo cáo) |
| P5 khứ hồi | bộ phân tích tham chiếu `.http` viết riêng (`test/support/http-parser.ts`): 300 mẫu có tên, giá trị, docs, body, script độc hại (xuống dòng, `###`, `# @name`…) → đúng số request, chỉ thị, header; không chỉ thị lạ; `@name` duy nhất; body ngoài tồn tại |
| P6 không đụng nguồn | ảnh chụp cây nguồn trước/sau trong các test trên đĩa và luồng `ImportHost` |
| P7 hiệu năng | 5.000 request trong 50 thư mục: khoảng 0,3 giây trên máy này (ngưỡng test 5 giây) |
| P8 kế thừa | hàm tham chiếu độc lập, 1.000 cây ngẫu nhiên |

Mỗi mã `TC-*` trong danh mục được tạo ra bởi ít nhất một fixture (test `Every code of the catalog is produced by at least one fixture`); việc này phát hiện ra hai mã (`TC-VERSION-UNKNOWN`, `TC-SETTINGS-DROPPED`) có trong đặc tả nhưng chưa được mã nguồn tạo ra.

Kiểm tra bằng đột biến: `npm run mutate` (`tools/mutate.cjs`) phá cố ý 20 quy tắc (kế thừa baseUrl/auth/header/test, chuyển bí mật, tên header bí mật, xung đột Authorization, xuống dòng, body `###`, trùng tên, `@` trong chú thích, tên header, `.gitignore`, tên kết thúc bằng dấu chấm, bí mật vào tệp riêng, symlink, escape markdown, header trùng hoa thường, hoàn tác khi lỗi) và đòi bộ test phải đỏ: **20/20 bị bắt**. Một đột biến đầu tiên (bỏ kiểm tra `..`) sống sót vì nó thừa: `..` kết thúc bằng dấu chấm nên vẫn bị quy tắc dấu chấm cuối chặn.

Chạy thật trong VS Code (`node extension/test/run.cjs`, dùng VS Code đã cài với profile, thư mục extension và workspace tạm; không tải gì): lệnh được kích hoạt, thư mục "của Thunder Client" tìm thấy cạnh nơi lưu extension của chính trình soạn thảo, đi hết các Quick Pick thật, ghi tệp, bí mật chỉ ở tệp riêng tư, `.gitignore`, báo cáo mở dạng tài liệu ảo, và một lần chạy thứ hai bị hủy không ghi gì. Đã chạy thành công với VS Code 1.107.1 trên Windows.

### 10.3b Thử trong REST Client thật (2026-10-20)

`samples/rest-client-check/` (`run.cjs`, `suite.cjs`): VS Code đã cài, profile và thư mục extension tạm, REST Client 0.25.1 cài từ gói VSIX (905.049 byte, sha256 `0d2cd9f7…ccca7`, tải từ Marketplace), một máy chủ giả trên `127.0.0.1` ghi lại cái REST Client gửi. Mỗi request của mẫu (18 request, 6 tệp `.http`, thêm 1 tệp thử viết tay) được gửi bằng lệnh `rest-client.request` với con trỏ ở dòng request. Kết quả:

| Điều kiểm | Kết quả |
|---|---|
| `# @name`, `# @assert`, `# @capture`, `# [disabled …]`, `# | script` làm REST Client hiểu nhầm? | Không: cả 18 request đến đúng phương thức, đường dẫn, header |
| `Authorization: Basic admin:mật-khẩu` | REST Client mã hóa base64 (nhận đúng `Basic YWRtaW46…`) |
| Bearer, header kế thừa, tham số query đã bị tắt, auth `none` | đúng như tệp (request `auth: none` không có `Authorization`) |
| multipart có phần đính kèm `< ./data/…` | gửi đúng nội dung tệp |
| GraphQL (JSON) | đúng |
| body có dòng `#` hoặc `//` để tại chỗ | **dòng bị xóa lặng lẽ** (lỗi của cách phát ban đầu; sửa bằng tách ra tệp) |
| body có dòng `< ./secret.txt` để tại chỗ (tệp `.http` viết tay) | **REST Client gửi nội dung của tệp đó** (`hello
TOPSECRET…
bye`): dữ liệu độc hại trong một collection nhập vào có thể làm request gửi đi một tệp trên đĩa. Với đầu ra của importer (tách ra tệp), nội dung tệp mồi không lọt vào request nào |
| body tách ra tệp bằng `< ./_bodies/…` | gửi đúng từng dòng (REST Client thêm `
` cuối); phần chữ multipart tách ra cũng đúng |
| `http-client.env.json` | **REST Client không đọc tệp này.** Biến đến từ `rest-client.environmentVariables`; importer viết `rest-client.settings.json` và `rest-client.private.settings.json` cho việc đó (§6.5, đã thử thật: workspace + người dùng gộp, chọn môi trường, toàn bộ request đúng giá trị) |
| Mạng | Dù `rest-client.enableTelemetry` tắt và `telemetry.telemetryLevel` tắt, tiến trình in một lỗi `ApplicationInsights:CorrelationIdManager ECONNRESET`: REST Client có mở kết nối ra ngoài. Không phải mã của ta |

Chưa thử: JetBrains HTTP Client và httpYac (OQ13), và độ sai khác phiên bản REST Client mới hơn 0.25.1 (bản đã tải cập nhật lần cuối 2022-08).

### 10.3c Thử trong httpYac thật (2026-10-20)

`samples/httpyac-check/`, cùng cách làm như §10.3b: extension `anweber.vscode-httpyac` 6.16.7 (gói 1.000.991 byte, sha256 `340c95b0…54c4`, tải từ Marketplace) trong profile tạm, máy chủ giả trên `127.0.0.1`, lệnh `httpyac.send` với con trỏ ở dòng request. Khác REST Client: **httpYac tự đọc `http-client.env.json` và `http-client.private.env.json`** của importer (chỉ đổi `baseUrl` sang máy chủ giả), nên không phải chép biến vào cài đặt.

| Điều kiểm | Kết quả |
|---|---|
| Mọi request của mẫu (21, gồm 3 request độc hại) | cả 21 đến đúng phương thức, đường dẫn, header, body |
| `# @name`, `# @assert`, `# @capture`, `# [disabled …]` | không hiểu nhầm, không lỗi (không có chẩn đoán nào), request vẫn gửi |
| Biến từ tệp môi trường (chung, có tên, riêng tư gộp vào cùng môi trường `dev`) | đúng; chọn môi trường bằng cài đặt `httpyac.environmentSelectedOnStart` |
| `Basic admin:mật-khẩu`, Bearer, multipart có tệp đính kèm, GraphQL | đúng (Basic được mã hóa) |
| Body ở tệp ngoài `< ./_bodies/…` | gửi đúng từng dòng, kể cả `#`, `//`, `###`, `< ../secret.txt` bên trong |
| Tự thêm `Accept: */*` khi request không có `Accept` | có (REST Client không) |
| `{{ biểu_thức }}` trong body, header, URL (tệp `.http` viết tay) | **httpYac chạy nó như JavaScript** (`require('fs').writeFileSync(…)` trong cả ba chỗ đều ghi được tệp) |
| `{{$processEnv TÊN}}` (viết tay) | **đưa giá trị biến môi trường vào request**; REST Client 0.25.1 cũng vậy |
| `< ./secret.txt` trong body (viết tay) | httpYac gửi nội dung tệp (như REST Client) |
| dòng `{{ exports.zz = 'RAN' }}` trong body (viết tay) | request **không được gửi** (khối mã nuốt vùng body); chưa tìm hiểu thêm |
| Với đầu ra của importer có chữ độc hại | không biểu thức nào chạy, không giá trị môi trường nào lọt vào request nào (§5.7a) |

Phát hiện gây ra sửa đổi: §5.7a (làm vô hại chữ trông như mã giữa `{{ }}`) và `TC-EXPRESSION-NEUTRALIZED`. Việc kiểm cũng lộ ra `variableSpans` chạy bình phương trên 200.000 dấu `{` liên tiếp (90 giây); đã viết lại thành một lượt (80 ms) và có test so với bản cũ trên 3.000 chuỗi ngẫu nhiên.

Chưa thử: JetBrains HTTP Client (OQ13); cách httpYac xử lý tên biến có dấu gạch ngang hay dấu chấm trong tệp môi trường (`{{base-url}}` được đọc như phép trừ nếu là biểu thức; importer hiện giữ tên như Thunder, chưa đổi tên biến).

### 10.3d Thử trong JetBrains HTTP Client thật (2026-10-20)

`samples/jetbrains-check/`: **`ijhttp`**, dòng lệnh chính thức của JetBrains HTTP Client (image Docker `jetbrains/intellij-http-client:263.7031.23`, digest `sha256:a31ebf64…ed6e03`, 162 MB nén, kéo từ Docker Hub). Chạy trên một mạng Docker `--internal` (không ra được internet, không mở cổng ra máy) cùng một máy chủ ghi lại request (`node:22-bookworm`), thư mục gắn chỉ-đọc, tệp môi trường của importer qua `-v`, `-p`, `-e dev`. Lưu ý: đây là CLI, không phải IDE; dùng chung lõi nhưng chưa chắc giống từng chi tiết.

| Điều kiểm | Kết quả |
|---|---|
| 22 request của mẫu | 21 đến đúng; request thứ 22 (`{{$guid}}`) lỗi, xem §5.7 |
| `# @name`, `# @assert`, `# @capture`, `# [disabled …]` | không hiểu nhầm, không lỗi, 0 bài kiểm thất bại |
| Tệp môi trường của importer (chung, có tên, riêng tư) | đúng, là định dạng gốc của JetBrains |
| `Basic admin:{{biến}}` (bản trước) | **sai**: `admin::mật-khẩu` được mã hóa; `Basic admin:mật-khẩu` viết tay không được mã hóa; `Basic admin mật-khẩu` đúng. Đã đổi sang dạng cách nhau bằng dấu cách (§6.2) |
| multipart (phần chữ, tệp đính kèm, phần chữ ở tệp ngoài) | đúng (JetBrains tự đặt lại boundary) |
| Body ở tệp ngoài (chứa `#`, `//`, `###`, `< ../secret.txt`) | gửi nguyên văn |
| `< ./secret.txt` trong body (viết tay) | JetBrains gửi nội dung tệp (và bỏ xuống dòng) |
| `> {% client.test(…) %}` trong body (viết tay) | **JetBrains coi là bộ xử lý phản hồi và chạy nó** (một bài kiểm cố ý thất bại hiện ra, exit code 1), body gửi đi chỉ còn `before` |
| `{{ (1 + 1) }}` | không chạy JavaScript (giữ nguyên chữ); `{{$processEnv HOME}}` không có; **`{{$env.HOME}}` đọc biến môi trường** (ra `/root`) |
| Với đầu ra của importer có chữ độc hại | không có tệp, biến môi trường hay bộ xử lý nào lọt vào request |

Hai điều lạ của chính JetBrains CLI: image khởi động `java` qua một shell không có dấu nháy nên đường dẫn có dấu cách (`Pet Store/…`) bị cắt (bộ thử gọi `java` thẳng); và một biến riêng tư có giá trị rỗng (`legacy_secret`, biến mã hóa phải nhập lại) làm bộ che bí mật của nhật ký `-L VERBOSE` chèn `{{**legacy_secret**}}` giữa từng ký tự, chỉ ảnh hưởng nhật ký.

### 10.4 Xác nhận trên dữ liệu thật

Script `tools/thunder-structure.cjs` (đã viết, xem [tools/README.md](../tools/README.md)) chạy tay, ngoài extension, in **chỉ cấu trúc** (tên khóa, kiểu giá trị, hình dạng giá trị, giá trị của vài trường liệt kê như `body.type`, `auth.type`) của thư mục lưu trữ thật trên máy người dùng, không in giá trị tự do. Dùng để đóng các câu hỏi §12 mà không lộ dữ liệu. Có chế độ `--selftest` kiểm bằng chuỗi canary rằng không giá trị nào lọt vào báo cáo.

## 11. Pháp lý và đạo đức (không phải tư vấn pháp lý)

- Đọc **dữ liệu của chính người dùng** trên máy của họ để chuyển sang công cụ khác là tương tác dữ liệu hợp lý.
- Không sao chép mã, giao diện, chuỗi văn bản hay khóa của Thunder Client vào dự án. Bảng ánh xạ ở trên là **sự kiện về định dạng dữ liệu** tự viết lại, không phải mã nguồn của họ.
- Không giải mã dữ liệu mã hóa của họ (§8.4).
- Fixture lấy từ repo công khai: kiểm tra giấy phép trước khi đưa vào repo; nếu không rõ, tự dựng file cùng hình dạng.
- Mô tả extension chỉ nói nhập được định dạng, không ngụ ý liên kết hay xác nhận từ Thunder Client.

## 12. Câu hỏi mở và cách đóng

Chưa xác minh, theo thứ tự rủi ro. Cách đóng chung: chạy script ở §10.4 trên một bản dữ liệu v4 thật, hoặc xin một thư mục lưu trữ mẫu đã xóa giá trị.

| # | Câu hỏi | Rủi ro nếu sai |
|---|---|---|
| ~~OQ1~~ | ~~Cấp collection/thư mục có header, auth, test, script kế thừa không?~~ **ĐÃ ĐÓNG (2026-10-20):** có, đọc từ mã 3.0.0; thuật toán ở N15–N19. Còn lại `[?]`: điều kiện áp `baseUrl` lúc chạy (N15), và hình dạng chính xác của `runRequests` | |
| OQ2 | Một file v4 thật của 3.0.0: `body.raw` là chuỗi hay mảng dòng? có trường mới? | Phải xử lý cả hai (đã có N1), nhưng trường lạ có thể bị bỏ sót |
| OQ3 | Trường của `auth.oauth2` và `auth.apikey` | Hiện chỉ báo không hỗ trợ; OAuth2 nằm trong gói free nên người dùng sẽ gặp nhiều |
| OQ4 | `reqType` `graphql` và cấu trúc `ws`/`sse`/`grpc` | Bỏ sót hoặc hiểu sai loại request |
| OQ5 | Cú pháp `custom` của `json-query` (có tiền tố `json.` như `set-env-var`?) | Assertion JSON sai đường dẫn |
| OQ6 | Tên thư mục dữ liệu của Cursor, Windsurf, Kiro, Antigravity | Gợi ý đường dẫn sai (đã có "Chọn thư mục…" làm dự phòng) |
| OQ7 | Cấu trúc `thunderLocalEnvironment.json` (v3) | Mất biến cục bộ ở dữ liệu cũ |
| OQ8 | Nâng cấp v3 → v4 làm gì với tệp (mã có, chưa quan sát) | Gặp cả hai bố cục cùng lúc ngoài dự kiến |
| OQ9 | Phần mở rộng của `Content-Type` cho `text`/`xml` | Header sai nhẹ |
| ~~OQ10~~ | ~~`$shared` có được các công cụ chấp nhận?~~ **ĐÃ ĐÓNG bằng cách tránh dùng** (§6.5: làm phẳng) | |
| ~~OQ11~~ | ~~Quyết định D1, D3~~ **ĐÃ CHỐT** (§6.0). Chỉ cần xem lại nếu đổi hướng sản phẩm | |
| ~~OQ13~~ | ~~Dòng `# @…` trong chú thích có làm REST Client / JetBrains / httpYac hiểu nhầm không?~~ **ĐÃ ĐÓNG (2026-10-20):** không, cả ba (§10.3b, c, d). Giữ tiền tố `# @`. | |
| OQ12 | Runtime sẽ hiện thực biến hệ thống nào (`SYSVAR_MAP`)? | Chỉ ảnh hưởng mức "để nguyên" |
| ~~OQ14~~ | ~~Dòng trong body bắt đầu bằng `#` hoặc `//` có bị xóa không?~~ **ĐÃ ĐÓNG cho REST Client (2026-10-20):** có, bị xóa lặng lẽ; và dòng `< tệp` trong body bị REST Client đọc thành nội dung tệp. Đã xử lý bằng cách tách body ra tệp (§6.1). JetBrains và httpYac chưa thử, nhưng cách xử lý là phần chung nhỏ nhất nên vẫn đúng | |
| OQ15 | Phần đính kèm của Thunder (`files`, `isFile`): `value` là đường dẫn nào (tên trong thư mục `files/` của Thunder hay đường dẫn tuyệt đối)? | Request nhập được nhưng trỏ vào tệp không tồn tại; đã báo `TC-FILE-PATH` khi tuyệt đối hoặc đi lên |

## 13. Thứ tự làm việc đề xuất

1. Thử OQ13 (một buổi): viết tay một tệp `.http` có `# @name`, `# @assert`, `# @capture` rồi mở bằng REST Client, JetBrains, httpYac, xem có công cụ nào hiểu nhầm không; đổi tiền tố nếu cần. Khung dự án đã dựng (2026-10-20): xem [README.md](../README.md) và `npm run check`.
2. Reader + phân loại + giới hạn (§2, §8.1–8.2) cùng F1–F3 F11.
3. Normalize N1–N14 + IR, với F1–F8 F12.
4. Emitter E1 + tên tệp + xác định (§6), P1 P3 P5 P6.
5. Bí mật (§8.3, 8.4) + F10 + P4.
6. Lớp VS Code: Quick Pick, báo cáo, ghi (§9).
7. Chạy §10.4 trên dữ liệu thật, đóng OQ2–OQ9 còn lại (OQ1, OQ10, OQ11 đã đóng), chỉnh bảng.

Mỗi bước kết thúc bằng `npm run check` tương đương và một commit riêng, như Git Pro.

**Trạng thái:** các bước 2 đến 6 đã làm xong và được kiểm bằng bộ test, kiểm tra đột biến, và chạy thật trong REST Client, httpYac, JetBrains HTTP Client và VS Code (§10.3). Bước 1 đã làm cho cả ba công cụ `.http` (§10.3b đến §10.3d). Còn lại bước 7: cần một thư mục dữ liệu v4 thật để đóng OQ2 đến OQ9 (script ở [`tools/thunder-structure.cjs`](../tools/README.md)). Tên sản phẩm chưa chọn.

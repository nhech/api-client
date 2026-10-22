# API Client

[![CI](https://github.com/nhech/api-client/actions/workflows/ci.yml/badge.svg)](https://github.com/nhech/api-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Một **API client miễn phí, ưu tiên làm việc cục bộ, cho Visual Studio Code**. Request của bạn là các file thường nằm trong repository: không tài khoản, không giới hạn số collection hay số request, không telemetry, không máy chủ của chúng tôi. Bạn viết request, bấm Gửi và đọc kết quả ngay bên cạnh. Chính những file đó là thứ Git hiển thị trong pull request.

Extension chỉ gửi những request **bạn** gửi và, với request dùng OAuth 2.0, các request tới máy chủ token và trang đăng nhập bạn đã cấu hình; khi bạn nhập mô tả OpenAPI từ một địa chỉ, nó gửi đúng một request GET để lấy mô tả đó. Không có gì khác rời khỏi máy.

> Không liên kết với, cũng không được Thunder Client, Postman, REST Client, httpYac hay JetBrains xác nhận. Tên chỉ dùng để chỉ định dạng dữ liệu được đọc hoặc ghi.

English: [README.md](README.md) (bản đầy đủ nhất).

## Có gì

- **Trình soạn request và khung kết quả cạnh nhau, hoặc xếp trên-dưới như Postman** (hai nút ở đầu request, hoặc setting `apiClient.layout`). Phương thức và địa chỉ, rồi các tab Query, Headers, Auth, Body (JSON, text, XML, form, multipart có tệp, GraphQL, tệp nhị phân), Scripts, Settings, Docs và Code. Kết quả có thân (đẹp hoặc thô; ảnh được hiển thị), header, cookie, test, console của script, request như đã gửi và dòng thời gian (tra tên, kết nối, TLS, chờ, tải).
- **Collection, thư mục và môi trường ở thanh bên**: cây gốc của VS Code, kéo thả, đổi tên, nhân bản, chuyển, lọc, theo màu của theme. Thư mục hay collection đặt những gì request con dùng chung (base URL, header, xác thực, biến, test, script, cài đặt); cái gần nhất thắng.
- **Request là file.** Mỗi request một file YAML, thư mục là thư mục, thứ tự nằm trong file của thư mục, thân và script là khối đọc được nên diff theo từng dòng. Cạnh mỗi request có thêm một bản sao `.http` cho người dùng REST Client, httpYac hay JetBrains.
- **Biến và môi trường**, giá trị bí mật nằm ngoài Git. `{{ten}}` trong địa chỉ, header, thân, xác thực; từ động như `{{$guid}}`; mục ở thanh trạng thái để đổi môi trường.
- **Xác thực:** kế thừa, không, bearer, basic, API key và **OAuth 2.0** (client credentials, password, authorization code có PKCE, refresh); token nằm trong secret storage của VS Code.
- **Test và biến bắt** là các dòng quy tắc (`status == 200`, `json $.id exists`, `token = json $.access_token`) và **script JavaScript trước/sau request** (tập con của API `pm` của Postman), chạy trong sandbox và chỉ sau khi bạn cho phép đúng đoạn mã đó.
- **Runner cho collection:** số lượt, quãng nghỉ, tệp dữ liệu CSV hoặc JSON, dừng ở lỗi đầu tiên, báo cáo JSON và JUnit.
- **Nhập** từ mô tả **OpenAPI hoặc Swagger** (một file, hoặc địa chỉ của chương trình đang chạy), từ **các route trong controller của chính bạn** (dò trong mã nguồn của workspace), từ Thunder Client, Postman (collection và môi trường) và cURL (chép lệnh rồi dán thành request).
- **Tab Code** viết request thành cURL, PowerShell, JavaScript (fetch hoặc axios), Python, Go, C#, PHP hay Java, đã bỏ các bí mật.

## Bắt đầu nhanh

Cài **API Client** từ [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=longtd.api-client) (tìm trong Extensions, hoặc `ext install longtd.api-client`) hoặc từ Open VSX. Cần VS Code 1.100 trở lên và workspace cục bộ **đã tin cậy** (tắt trong Restricted Mode, trên trình duyệt và trong workspace ảo). Remote SSH, WSL và container chưa được thử bằng tay.

1. Mở một thư mục và biểu tượng **API Client** ở Activity Bar. *New Collection...* tạo `api-client/collections/<tên>/`.
2. *New Request...* trên collection. Gõ địa chỉ rồi bấm **Ctrl+Enter** (**Cmd+Enter** trên Mac) hoặc nút Send.
3. *New Environment...*, thêm `baseUrl` và dùng `{{baseUrl}}/pets` trong request; chọn môi trường ở thanh trạng thái.
4. Commit thư mục `api-client/`. Giá trị biến bí mật nằm trong các file `*.local.yml` mà `.gitignore` riêng của thư mục này giữ ngoài Git.

Dựng từ mã nguồn: `npm ci --ignore-scripts`, `npm run ext:build`, `cd extension && npm run package`, rồi `code --install-extension ../.artifacts/api-client.vsix`.

## Các file

```
api-client/
  workspace.yml                 biến và cài đặt của cả workspace
  .gitignore                    giữ các file *.local.yml ngoài Git
  collections/<ten>/
    collection.yml              base URL, header, xác thực, biến, test, script, cài đặt, thứ tự
    collection.local.yml        giá trị biến bí mật của collection (không đưa vào Git, quyền 0600)
    <thu-muc>/folder.yml        những gì thư mục đặt, và thứ tự request của nó
    <thu-muc>/ten.req.yml       một request
    <thu-muc>/ten.http          bản sao .http được sinh ra, đừng sửa
  environments/
    dev.env.yml                 biến của một môi trường
    dev.env.local.yml           bí mật của nó (không đưa vào Git)
```

Bộ đọc là một tập con chặt của YAML (không anchor, alias, tag hay flow collection, không khóa trùng, có giới hạn kích thước và độ sâu), nên file đến từ người khác chỉ là dữ liệu. *Open as Text* mở YAML của bất kỳ request nào để sửa tay.

## Biến, môi trường và bí mật

`{{ten}}` được thay bằng giá trị ở phạm vi gần nhất có nó: cái mà biến bắt hay script đã đặt khi chạy, rồi biến của thư mục và collection từ trong ra ngoài, rồi môi trường đang chọn, rồi workspace. Từ động tra trong một bảng cố định (`{{$guid}}`, `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt a b}}`, `{{$randomBoolean}}`, `{{$randomString}}`, `{{$randomEmail}}`). Không gì giữa `{{ }}` bị đánh giá như mã.

Một biến có thể đánh dấu **bí mật**: giá trị nằm ở file `*.local.yml` cạnh file chung và bị che ở mọi nơi có hiển thị hay ghi lại (lịch sử, tab Code, bản sao `.http`, báo cáo, console, thông báo lỗi). Cái mà request và script đặt khi chạy chỉ nằm trong bộ nhớ, thuộc về collection đã đặt nó, và không bao giờ được ghi vào file.

## Script, runner, nhập

- **Script** chạy trong QuickJS biên dịch ra WebAssembly, trong một worker thread, với giới hạn thời gian, bộ nhớ, đầu ra và số lệnh gọi. Một script đọc được mọi biến nó được đưa, kể cả bí mật, và gửi đi đâu cũng được, nên **không có gì chạy cho đến khi bạn đồng ý đúng đoạn mã đó**; mỗi thay đổi (pull, đổi nhánh, sửa) hỏi lại, và nhập dữ liệu không bao giờ cấp quyền. Xem [docs/client/scripts.md](docs/client/scripts.md).
- **Runner** (*Run Collection or Folder*) chạy request theo thứ tự thanh bên, hiện từng kết quả và lưu báo cáo JSON hoặc JUnit. Xem [docs/client/runner.md](docs/client/runner.md).
- **Nhập** (*Import...*) đọc mô tả OpenAPI hoặc Swagger (một thư mục cho mỗi tag, một request cho mỗi operation, môi trường cho mỗi server), các route trong controller của bạn, và dữ liệu của công cụ khác, và không ghi gì đến khi bạn đồng ý; thông tin xác thực gõ trong request nhập vào trở thành biến bí mật của collection. Xem [docs/client/import.md](docs/client/import.md). Công cụ chuyển Thunder Client thẳng ra file `.http` (lệnh và dòng lệnh) vẫn còn: [docs/converter.md](docs/converter.md).

## An toàn

Dữ liệu nó đọc đến từ người khác (repository clone về, câu trả lời của máy chủ, file của công cụ khác) nên được coi là thù địch: file được phân tích như dữ liệu và không bao giờ chạy, đường dẫn không ra khỏi collection, chuyển hướng không mang thông tin xác thực sang origin khác và không đi từ internet vào máy hay mạng của bạn trừ khi bạn cho phép, bí mật bị che theo giá trị lẫn theo tên ở mọi nơi ghi lại, script cần bạn đồng ý đúng đoạn mã, còn các trang không có mạng và có Content-Security-Policy chặt. [SECURITY.md](SECURITY.md) liệt kê nó phòng thủ trước điều gì, điều gì không (một script bạn đã cho phép đọc được mọi biến nó được đưa), các đợt kiểm toán đã qua và cách báo lỗi.

## Giới hạn

- Mới có HTTP/1.1 (chưa HTTP/2), chưa WebSocket, server-sent events hay gRPC, chưa xác thực digest, AWS hay NTLM, chưa chứng chỉ máy khách, chưa proxy SOCKS hay PAC.
- Đọc và kiểm tra bản sao `.http` của mọi request được làm lại cho cả collection mỗi khi một file đổi: đến một nghìn request thì không ai thấy; ở mười nghìn mỗi lần sửa giữ extension host vài giây ([docs/client/performance.md](docs/client/performance.md)).
- Remote SSH, WSL, container và secret storage của máy từ xa chưa được thử bằng tay.
- Đang ở bản preview: định dạng file còn có thể đổi giữa các phiên bản (file mang `schema: 1` và được di chuyển).

## Phát triển

`npm run check` (kiểu, kiểu của extension, lint, mọi test, tự kiểm của công cụ), `npm run mutate` (phá cố ý các quy tắc bảo vệ và đòi test đỏ), `npm run ext:host-test` (chạy extension trong VS Code đã cài với profile tạm), `node scripts/package-extension.cjs` (dựng và kiểm gói `.vsix`). Mỗi thư mục của `src/` chỉ được import những gì vùng của nó cho phép (`test/support/zones.ts`, kiểm bởi `test/unit/purity.test.ts`). Xem [CONTRIBUTING.md](CONTRIBUTING.md).

Đặc tả của công cụ chuyển đổi Thunder Client (tiếng Việt): [docs/SPEC.vi.md](docs/SPEC.vi.md).

## Giấy phép

[MIT](LICENSE) © 2026 longtd.

# agy-browser

Cho agy (Google Antigravity) điều khiển **Chrome thật của bạn** (giữ nguyên đăng nhập, cookie), cùng kiến trúc với Claude in Chrome:

```
agy ──stdio (MCP)──> agy-browser (Rust)  ── hub WebSocket 127.0.0.1:8765
                                               ▲ /ext            ▲ /peer
                                    Chrome extension     các phiên agy khác
                                    (chrome.debugger + chrome.scripting)
```

- Mỗi phiên agy có "tab hiện tại" riêng, nên nhiều agent chạy song song không giành tab của nhau.
- Phiên agy đầu tiên chiếm cổng và làm **hub**. Các phiên sau tự nối vào hub qua `/peer`. Nếu hub tắt, phiên kế tiếp tự lên làm hub.
- Hub chỉ nhận kết nối có Origin `chrome-extension://…` (ở `/ext`) hoặc không có Origin (process local, ở `/peer`), nên trang web không tự kết nối vào được.

## Vì sao nhanh hơn Playwright MCP

- Không khởi động trình duyệt mới mà gắn vào Chrome đang mở.
- `snapshot` được tạo ngay trong trang (mất vài ms), chỉ liệt kê phần tử tương tác kèm `ref`, không dump cả cây accessibility.
- Thao tác xong không tự snapshot lại; agent chỉ snapshot khi cần.
- `fill` điền nhiều trường trong một lần gọi.

Số liệu đo trên trang test: snapshot ~10ms, fill 3 trường ~5ms, click ~130ms, screenshot ~25–180ms.

## Cài đặt

1. Build server:
   ```sh
   cargo build --release
   ```
2. Nạp extension: mở `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked** rồi trỏ tới thư mục `extension/`.
   Khi agy đang chạy, icon extension hiện badge **ON**.
3. Khai báo trong `~/.gemini/antigravity-cli/mcp_config.json`:
   ```json
   "agy-browser": {
     "command": "/Users/huanpham/MyProjects/agy-browser/target/release/agy-browser"
   }
   ```

4. Cài skill để agy biết cách dùng tool hiệu quả:
   ```sh
   ln -s /Users/huanpham/MyProjects/agy-browser/skill ~/.gemini/skills/agy-browser
   ```

Sau khi sửa `extension/background.js`, bấm **Reload** extension trong `chrome://extensions`.

## Tools

| Tool | Việc |
|---|---|
| `tabs_list`, `tab_new`, `tab_select`, `tab_close` | Quản lý tab. Tab agy mở được gom vào tab group **agy-browser**; các tool khác mặc định chạy trên tab hiện tại |
| `navigate` | URL, hoặc `back` / `forward` / `reload`; chờ trang load xong |
| `snapshot` | Dàn ý trang kèm ref (`mode: all` để có thêm text) |
| `click` | Theo `ref` hoặc toạ độ `x,y` (CSS px, khớp với screenshot) |
| `fill` | Điền input/select/checkbox, một hoặc nhiều trường (`fields`) |
| `type`, `press_key` | Gõ phím thật qua CDP (`Meta+a`, `Tab Tab Enter`…) |
| `scroll`, `screenshot`, `get_text`, `evaluate`, `console_logs`, `wait_for` | |
| `network_requests`, `network_request` | Danh sách request (mặc định fetch/XHR/document, lọc theo regex, type, lỗi) và chi tiết header/body của từng request. Header cookie/authorization bị ẩn trừ khi truyền `showSecrets` |

## Cấu hình

| Biến môi trường | Mặc định | |
|---|---|---|
| `AGY_BROWSER_PORT` | `8765` | Nếu đổi thì sửa luôn `PORT` trong `extension/background.js` |
| `AGY_BROWSER_EXTENSION_ID` | (trống) | Chỉ nhận extension có ID này |

## Hiệu ứng khi điều khiển

Khi agy điều khiển một tab, viền tab đó phát sáng và có con trỏ giả di chuyển tới chỗ click, kèm hiệu ứng gợn sóng. Viền sáng tự tắt sau 8 giây không có thao tác. Overlay không lọt vào `snapshot`, `get_text` hay `screenshot`, cũng không chặn click.

- Đổi màu: sửa `COLOR` trong hàm `pageOverlay` (`extension/background.js`).
- Tắt hẳn: đặt `SHOW_OVERLAY = false`. Mỗi lần click sẽ nhanh hơn khoảng 190ms vì không phải đợi con trỏ di chuyển.

## Test

```sh
tests/run.sh
```

Lệnh này chạy 22 bài kiểm tra end-to-end (tab và group, focus, form, phân tách phiên, console, network, chuyển giao hub) trên Chrome for Testing headless. Lần đầu nó tự tải Chrome for Testing vào `tests/.cache`. Test dùng cổng riêng (`HUB_PORT=8797`, `SITE_PORT=8811`) nên không ảnh hưởng phiên agy đang chạy.

## Giới hạn hiện tại

- Snapshot chưa đi vào iframe; shadow DOM dạng open thì có.
- Khi đang thao tác, Chrome hiện thanh "agy browser bridge started debugging this browser". Đây là hành vi bắt buộc của `chrome.debugger` và Claude in Chrome cũng bị.

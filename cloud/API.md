# SAMA HTTP API v1

实现入口 `server.mjs`。所有时间使用 UTC ISO 8601（带 `Z`）；网页显示 SGT。资源 ID 为稳定标识，名称可改。`owner_id` / `ownerId` 是个人空间所有者，不能作为客户端授权凭据。

## 会话与写入

登录：`POST /api/v1/auth/login`，JSON `{username,password}`，头 `Content-Type: application/json`、`X-Sama-Request: 1`。成功设置 HttpOnly 会话 Cookie，并返回 `{user,csrf}`。

其后所有请求携带 Cookie；所有写请求另带 `X-Sama-Request: 1` 和 `X-CSRF-Token: <csrf>`。有 Origin 头时必须等于配置的应用来源。不提供跨域 CORS。公开注册同样需要 JSON 与应用请求头，不能携带字段把自己提升为管理员。

状态码：400 输入错误；401 未登录；403 权限或 CSRF；404 无权限/不存在的资源统一返回；409 冲突；413 数据范围/文件过大；429 超出并发或频率；507 存储保护。失败格式 `{error,message}`。

- `GET /health`：公开存活检查。
- `GET /api/v1/auth/info`：公开注册状态。
- `POST /api/v1/auth/register`：`{username,name?,password}`，密码 10–128 位。
- `GET /api/v1/auth/me`：当前用户与 CSRF。
- `POST /api/v1/auth/logout`：撤销当前会话及 SSE。
- `PATCH /api/v1/auth/profile`：`{name}`。
- `POST /api/v1/auth/password`：`{oldPassword,password}`，成功后需要重新登录。
- `GET /api/v1/state`：授权传感器、实时状态、统计、存储诊断与指标定义。
- `GET /api/v1/events`：有身份范围的 SSE：`state / live / saved / sensor-status / refresh`。每账号最多 5 个订阅。

普通用户只能访问自己的资源；管理员全局可见。API 返回有界列表；管理员使用 `ownerId` 可在支持的查询中限定账号。旧版 `/api/state` 等公开端点不保留为旁路。

## 植物、状态与设备

- `GET /api/v1/plants?q=&offset=0&limit=60&archived=1`：植物搜索/分页；`limit` 1–100，默认不含归档。
- `POST /api/v1/plants`：`{name,code?,profile?,ownerId?}`；ownerId 仅管理员可为别人建档。
- `GET /api/v1/plants/:id`：档案、最近状态/照片、绑定时间线与版本。
- `PATCH /api/v1/plants/:id`：`{name?,code?,profile?,archived?}`。profile 字段为 `species,cultivar,substrate,pot,location,plantedAt,notes,growthStage`。
- `POST /api/v1/plants/:id/observations`：`{kind,happenedAt?,notes?,amount?,unit?,growthStage?}`。kind 为 `status,watering,fertilizing,repotting,moving,note`。
- `GET /api/v1/sensors`：当前有使用权的物理传感器；管理员返回全局列表。
- `PATCH /api/v1/sensors/:id`：`{name?,intervalMs?,profile?}`。传感器 profile 的 `model,serialNumber,calibrationDate,calibrationNotes` 仅管理员能改。轮询间隔 1,000–3,600,000 ms。
- `POST /api/v1/sensors/:id/bind`：`{plantId}`；`plantId:null` 解绑。
- `POST /api/v1/sensors/:id/read`：`{}`，读取新值；只在匹配活动任务时入库，返回 `{sample,saved}`。
- `POST /api/v1/sensors/:id/manual`：`{name?,notes?}`，读取并保存新值。建议带 `Idempotency-Key`（8–100 位字母/数字/下划线/短横线）。活动段内保存到该段；无活动段则创建一次性段。
- `GET /api/v1/service-events?sensorId=`：有权限范围的最近诊断事件。

## 每段采集

`POST /api/v1/recordings`：

```json
{
  "sensorId": "<assigned-sensor-id>",
  "name": "Orchid A morning",
  "startAt": "2026-10-24T00:00:00.000Z",
  "endAt": "2026-10-24T02:00:00.000Z",
  "intervalMs": 60000,
  "stabilizeSeconds": 300,
  "fullResolution": false,
  "notes": "Measurement after moving the probe"
}
```

起止时间可不填；留空开始即现在、结束即手动停止。开始后的稳定等待不保存。存档间隔范围 1,000–86,400,000 ms，不能小于当前设备轮询间隔。植物来自当前有效绑定；同一传感器任务不重叠。

- `GET /api/v1/recordings?plantId=`：最近 300 段。
- `POST /api/v1/recordings/:id/stop`：`{}`。
- 状态：`scheduled,running,completed,stopped,failed`。
- 每条样本冻结账号、植物、传感器、网关、绑定、采集段及传感器/解析元数据。0 与 null 分别处理，CRC 失败不作为成功样本。

## 历史、导出与后台任务

- `GET /api/v1/measurements?plantId=&sensorId=&recordingId=&since=&until=&after=0&limit=300`：仅热明细；按 seq 正序，返回 `{samples,next,tier:"hot"}`。
- 加 `latest=true&before=<seq>` 读取最近的一页，返回的页内数据仍正序。
- `POST /api/v1/history-queries`：冷热完整分页，过滤字段见下；每页 300 条，结果位于任务的 `result.preview`，后续使用 `result.nextBefore` 作为 `beforeSeq`，沿用 `result.maxSeq`。
- `POST /api/v1/exports`：同样的范围，增加 `format:csv|ndjson|zip`、`includePhotos`。ZIP 必须选择 plantId。
- `GET /api/v1/jobs`、`GET /api/v1/jobs/:id`、`POST /api/v1/jobs/:id/cancel`。
- `GET /api/v1/jobs/:id/download`：已完成的导出流，7 天有效；每次重新鉴权。

过滤 JSON：`{plantId?,sensorId?,recordingId?,ownerId?,since?,until?,selectedOnly?,beforeSeq?,maxSeq?}`。`selectedOnly:true` 选取按设定间隔保存或手动保存的点；false 包括额外留存的全分辨率读数。

任务状态 `queued,running,ready,failed,cancelled,expired`。每次扫描 500,000 条以内，导出单文件 256 MiB 以内，超限明确失败，需缩小范围。取消不保证中断一个已经提交到 OSS 的网络请求，但取消结果不会成为可下载任务。

采样主要字段：`id,seq,timestamp,startedAt,ownerId,plantId,sensorId,gatewayId,assignmentId,recordingId,source,selected,captureReason,values,registers,frames,warnings,metricDefinitions,parserVersion,sensorProfile,calibrationStatus`。

`source=demo` 为模拟；`hardware` 为协议解析的硬件数据。每条 `values` 中键为稳定的指标 ID，单位从随记录冻结的 `metricDefinitions` 获取。

## 照片

1. `POST /api/v1/assets` 创建待上传记录：`{plantId,category,caption?,capturedAt?,sampleId?,sampleReference?,recordingId?,observationId?}`。
2. `PUT /api/v1/assets/:id/content` 上传原始 JPEG/PNG/WebP 二进制；仍需会话、应用头、CSRF 头。服务校验、转 WebP，完成后返回 ready 记录。
3. `GET /api/v1/assets/:id/content?thumb=1` 读取缩略图；去掉 thumb 读取展示图。

category 为 `profile,status,sample`。关联冷样本时提供 `sampleReference:{plantId,recordingId,timestamp}`，服务在所属归档中验证，不能直接相信客户端 ID。上传时间与拍摄时间分开；没有拍摄时间就保持未知。

## 模型上下文与可视化

- `POST /api/v1/plants/:id/context-snapshots`：`{since?,until?,selectedOnly?}`，创建 context 任务，正式输入默认排除模拟读数。
- `POST /api/v1/plants/:id/series`：相同范围，生成包括模拟数据的可视化上下文任务。
- 等待 job ready，读取 `result.snapshotId`。
- `GET /api/v1/context-snapshots/:id`：返回 `sama.plant-context.v1`。

快照包含生成时间、观测截止时间、seq 上界、当前植物档案及修订、绑定与任务、指标定义、数据统计、带单位的分桶序列、状态/养护记录、照片资源引用及质量限制。档案/照片带独立时间，调用方不能把当前描述自动当成过去一直成立的事实。

照片通过经过授权的应用资源路径获取，不把 OSS 内网地址提供给模型。未来模型服务身份和 bearer scopes 尚未开放；目前不要把用户会话凭据嵌入公开前端或发给外部模型。

## 管理员

- `GET/POST /api/v1/admin/users`；POST `{username,name?,password,role?}`。
- `PATCH /api/v1/admin/users/:id`：`{name?,password?,active?,role?}`，保护最后一个管理员。
- `GET/POST /api/v1/admin/gateways`；POST `{name,id?,simulated?}`。返回一次性显示的注册包。
- `POST /api/v1/admin/gateways/:id/rotate-key`：重置注册身份并关闭旧连接。
- `POST /api/v1/admin/sensors`：`{gatewayId,ownerId?,name,address?,intervalMs?,metrics?,profile?}`。
- `POST /api/v1/sensors/:id/transfer`：管理员 `{ownerId}`；null 收回使用权。
- `GET /api/v1/admin/audit`：最近审计。
- `POST /api/v1/admin/backup`：一致性备份到当前对象存储。

设备转交只改变使用权和后续测量；不能将原账号的植物、照片或历史一起交给新账号。

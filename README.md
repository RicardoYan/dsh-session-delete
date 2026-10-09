# dsh-session-delete

给 DSH 会话菜单加一个「删除会话」：连同它派生的所有子代理会话（任意层级）一起永久删除。

DSH 自带的只有归档，会话和子代理记录都还留在磁盘上。

## 安装

```sh
dsh plugin --profile desktop add github:RicardoYan/dsh-session-delete#v0.1.0
```

Web 端把 `desktop` 换成你的 profile 名（一般是 `web`）。装完重启 DSH。

卸载：`dsh plugin --profile desktop remove dsh-session-delete`

## 使用

会话行 `⋯` → **删除会话**。第一次点击会显示要连带删除几个子代理会话，再点一次才执行。

- 会清理：会话日志、投影缓存、工作区记录、spill 文件、浏览器里的界面状态
- 不会删：分叉（fork）出的会话、工作区文件夹里的项目文件
- 文件被占用时，下次启动 DSH 自动清掉

## 注意

- 删除不可撤销
- 依赖 DSH 的存储布局，适用于 `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`

## 许可证

MIT

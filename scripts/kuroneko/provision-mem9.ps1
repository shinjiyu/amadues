param(
  [int]$Count = 1
)
# 为 bot / 实验 agent 批量申请 mem9 Key（响应 JSON 的 id 即 MEM9_API_KEY）
for ($i = 1; $i -le $Count; $i++) {
  $raw = curl.exe -sX POST https://api.mem9.ai/v1alpha1/mem9s
  Write-Host "[$i] $raw"
}

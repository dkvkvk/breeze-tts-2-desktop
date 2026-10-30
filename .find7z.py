import io, os, sys, urllib.request, zipfile, subprocess
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
# 试 node 生态里的 7zip-bin（electron-builder 依赖里常有）
for cand in [
  r'shell\node_modules\7zip-bin\win\x64\7za.exe',
  r'shell\node_modules\7zip-bin\win\ia32\7za.exe',
]:
    print(cand, os.path.exists(cand))

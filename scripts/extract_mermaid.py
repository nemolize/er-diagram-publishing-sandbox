import re
import sys

text = open(sys.argv[1]).read()
block = re.search(r"```mermaid\n.*?```", text, re.S).group(0)
open(sys.argv[2], "w").write("# ER diagram\n\n" + block + "\n")

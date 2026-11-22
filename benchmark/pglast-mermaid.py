"""Parse a schema file with pglast and print a Mermaid erDiagram.

Declared foreign keys are drawn with a solid line. With --infer, a column named
<name>_id with no declared foreign key is drawn (dotted) to the table <name>s
(or to its own table for parent_id) when that table exists.
Usage: python pglast-mermaid.py schema.sql [--infer]
"""
import sys
from pglast import parse_sql
from pglast.enums import ConstrType

def table_name(rel):
    return rel.relname

def main(path, infer):
    tables, declared = {}, set()
    for raw in parse_sql(open(path).read()):
        stmt = raw.stmt
        if stmt.__class__.__name__ != "CreateStmt":
            continue
        name = table_name(stmt.relation)
        cols = []
        for elt in stmt.tableElts:
            kind = elt.__class__.__name__
            if kind == "ColumnDef":
                tname = ".".join(n.sval for n in elt.typeName.names if n.sval != "pg_catalog")
                pk = any(c.contype == ConstrType.CONSTR_PRIMARY for c in (elt.constraints or ()))
                cols.append((elt.colname, tname, pk))
                for c in elt.constraints or ():
                    if c.contype == ConstrType.CONSTR_FOREIGN:
                        declared.add((name, elt.colname, c.pktable.relname))
        tables[name] = cols
    print("erDiagram")
    for t, cols in tables.items():
        print(f"  {t} {{")
        for c, ty, pk in cols:
            print(f"    {ty} {c}{' PK' if pk else ''}")
        print("  }")
    fk_cols = {(t, c) for t, c, _ in declared}
    for t, c, target in sorted(declared):
        print(f"  {target} ||--o{{ {t} : \"{c}\"")
    if infer:
        for t, cols in tables.items():
            for c, _, _ in cols:
                if c.endswith("_id") and (t, c) not in fk_cols:
                    stem = c[:-3]
                    target = t if stem == "parent" else stem + "s"
                    if target in tables:
                        print(f"  {target} ||..o{{ {t} : \"{c}\"")

if __name__ == "__main__":
    main(sys.argv[1], "--infer" in sys.argv)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
入力データの前処理（読み取り専用・元データは絶対に変更しません）

Claude Code の読み取りツールは UTF-8 のテキストしか扱えないため、
    - Excel（.xlsx）  → ZIP+XML なのでそのままでは読めない
    - Shift_JIS のCSV → 日本語が文字化けする
という制約があります。

このスクリプトは、入力ディレクトリのファイルを読み取り専用で開き、
変換が必要なものだけを UTF-8 のテキストに変換して「作業用ディレクトリ」へ書き出します。
元のファイルには一切書き込みません。

使い方:
  prepare_input.py <入力ディレクトリ> <作業用ディレクトリ>

出力: 変換結果の一覧（1行1ファイル）を標準出力へ
"""

import sys
import os
import csv
import io
import re
import shutil
import zipfile
import xml.etree.ElementTree as ET

TEXT_EXT = {'.csv', '.tsv', '.txt', '.md', '.json'}
EXCEL_EXT = {'.xlsx', '.xlsm'}
LEGACY_EXCEL_EXT = {'.xls'}

# 日本語環境で想定される文字コードを、確からしい順に試す
# ※ utf-8-sig は BOM が無いUTF-8も復号できてしまうため、リストには入れず
#    BOM のバイト列を直接見て判定する（decode_text 参照）
ENCODINGS = ['utf-8', 'cp932', 'euc_jp', 'iso2022_jp']

BOM_UTF8 = b'\xef\xbb\xbf'

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def log(msg):
    sys.stdout.write(msg + "\n")


def col_index(ref):
    """A1 形式のセル参照から列番号(0始まり)を返す"""
    m = re.match(r'([A-Z]+)', ref or '')
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def xlsx_to_csv(path, out_dir, rel_base):
    """xlsx の各シートを CSV に変換する。戻り値: 生成したファイルの相対パス一覧"""
    made = []
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        log("SKIP\t%s\tExcelとして開けません: %s" % (rel_base, e))
        return made

    with z:
        # 共有文字列
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            try:
                root = ET.fromstring(z.read('xl/sharedStrings.xml'))
                for si in root.findall(NS + 'si'):
                    # <si> の中の全ての <t> を連結する（書式が分かれている場合に対応）
                    shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
            except ET.ParseError as e:
                log("WARN\t%s\t共有文字列の解析に失敗: %s" % (rel_base, e))

        # シート名の対応
        sheet_names = {}
        try:
            wb = ET.fromstring(z.read('xl/workbook.xml'))
            rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
            rid_target = {}
            for r in rels:
                rid_target[r.get('Id')] = r.get('Target')
            rkey = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
            for i, sh in enumerate(wb.iter(NS + 'sheet'), 1):
                tgt = rid_target.get(sh.get(rkey), 'worksheets/sheet%d.xml' % i)
                tgt = tgt.split('/')[-1]
                sheet_names[tgt] = sh.get('name') or ('sheet%d' % i)
        except Exception:
            pass

        sheets = sorted(n for n in z.namelist()
                        if n.startswith('xl/worksheets/') and n.endswith('.xml'))
        if not sheets:
            log("SKIP\t%s\tシートが見つかりません" % rel_base)
            return made

        for sheet_path in sheets:
            fname = sheet_path.split('/')[-1]
            sname = sheet_names.get(fname, fname.replace('.xml', ''))
            try:
                root = ET.fromstring(z.read(sheet_path))
            except ET.ParseError as e:
                log("SKIP\t%s\tシート %s の解析に失敗: %s" % (rel_base, sname, e))
                continue

            rows = []
            for row in root.iter(NS + 'row'):
                cells = {}
                for c in row.findall(NS + 'c'):
                    idx = col_index(c.get('r'))
                    t = c.get('t')
                    v = c.find(NS + 'v')
                    if t == 's':          # 共有文字列
                        try:
                            val = shared[int(v.text)] if v is not None else ''
                        except (ValueError, IndexError):
                            val = ''
                    elif t == 'inlineStr':
                        is_el = c.find(NS + 'is')
                        val = ''.join(x.text or '' for x in is_el.iter(NS + 't')) if is_el is not None else ''
                    else:
                        val = v.text if v is not None else ''
                    cells[idx] = val if val is not None else ''
                if cells:
                    width = max(cells) + 1
                    rows.append([cells.get(i, '') for i in range(width)])
                else:
                    rows.append([])

            # 末尾の空行を落とす
            while rows and not any(x.strip() for x in rows[-1]):
                rows.pop()
            if not rows:
                log("SKIP\t%s\tシート %s は空です" % (rel_base, sname))
                continue

            safe_sheet = re.sub(r'[/\\:*?"<>|]', '_', sname)
            base = os.path.splitext(os.path.basename(rel_base))[0]
            out_rel = os.path.join(os.path.dirname(rel_base),
                                   "%s__%s.csv" % (base, safe_sheet))
            out_abs = os.path.join(out_dir, out_rel)
            os.makedirs(os.path.dirname(out_abs), exist_ok=True)
            with open(out_abs, 'w', encoding='utf-8', newline='') as f:
                csv.writer(f).writerows(rows)
            log("EXCEL\t%s\t→ %s（%d行）" % (rel_base, out_rel, len(rows)))
            made.append(out_rel)
    return made


def decode_text(raw):
    """バイト列を復号する。戻り値: (テキスト, 文字コード名) / 失敗時 (None, None)

    BOM の有無はバイト列を直接見て判定する。
    utf-8-sig は BOM の無い UTF-8 も復号できてしまうため、
    codec の成否だけで判定すると全ファイルが「BOM付き」に見えてしまう。
    """
    if raw.startswith(BOM_UTF8):
        try:
            return raw.decode('utf-8-sig'), 'utf-8-sig'
        except UnicodeDecodeError:
            pass
    for enc in ENCODINGS:
        try:
            text = raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        # cp932 等は UTF-8 のバイト列も「復号できてしまう」ことがあるため、
        # UTF-8 で読めるものは UTF-8 を優先する（ENCODINGS の順序で担保）
        return text, enc
    return None, None


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    src = os.path.abspath(sys.argv[1])
    dst = os.path.abspath(sys.argv[2])

    if not os.path.isdir(src):
        sys.stderr.write("[prepare_input] 入力ディレクトリがありません: %s\n" % src)
        return 1
    if os.path.commonpath([src, dst]) == src:
        sys.stderr.write("[prepare_input] 作業用ディレクトリを入力ディレクトリの中に置けません\n")
        return 1

    os.makedirs(dst, exist_ok=True)

    n_copy = n_conv = n_excel = n_skip = 0

    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for name in sorted(files):
            if name.startswith('.'):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, src)
            ext = os.path.splitext(name)[1].lower()

            if ext in EXCEL_EXT:
                made = xlsx_to_csv(path, dst, rel)
                n_excel += len(made)
                if not made:
                    n_skip += 1
                continue

            if ext in LEGACY_EXCEL_EXT:
                log("SKIP\t%s\t旧形式のExcel(.xls)は変換できません。"
                    ".xlsx または CSV で保存し直してください" % rel)
                n_skip += 1
                continue

            if ext not in TEXT_EXT:
                log("SKIP\t%s\t対象外の形式です" % rel)
                n_skip += 1
                continue

            try:
                with open(path, 'rb') as f:
                    raw = f.read()
            except OSError as e:
                log("SKIP\t%s\t読み込めません: %s" % (rel, e))
                n_skip += 1
                continue

            text, enc = decode_text(raw)
            if text is None:
                log("SKIP\t%s\t文字コードを判別できません" % rel)
                n_skip += 1
                continue

            out_abs = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(out_abs), exist_ok=True)
            if enc in ('utf-8', 'utf-8-sig'):
                shutil.copy2(path, out_abs)
                if enc == 'utf-8-sig':
                    # BOM を取り除いて保存し直す
                    with open(out_abs, 'w', encoding='utf-8', newline='') as f:
                        f.write(text)
                    log("CONVERT\t%s\tBOM付きUTF-8 → UTF-8" % rel)
                    n_conv += 1
                else:
                    log("COPY\t%s\tUTF-8のためそのまま" % rel)
                    n_copy += 1
            else:
                with open(out_abs, 'w', encoding='utf-8', newline='') as f:
                    f.write(text)
                log("CONVERT\t%s\t%s → UTF-8" % (rel, enc))
                n_conv += 1

    log("SUMMARY\tそのまま=%d 変換=%d Excel展開=%d 対象外=%d" %
        (n_copy, n_conv, n_excel, n_skip))
    return 0


if __name__ == '__main__':
    sys.exit(main())

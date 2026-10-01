"""The names ECMA-262 accepts in a property escape, as JavaScript's ``u`` flag reads them.

Each line starts with the canonical name, followed by every other spelling ECMA-262 accepts.
Generated from Unicode 17.0's PropertyAliases.txt and PropertyValueAliases.txt, keeping each
spelling that Node.js 24 compiles under the ``u`` flag. A bare name must be a general category or
a binary property, and a script needs its ``Script=`` or ``sc=`` selector. The ``regex`` module
applies the Unicode version it ships, so a name newer than that version fails to compile.
Internal to the SDK.
"""

from __future__ import annotations


def _spellings(names: str) -> dict[str, str]:
    table: dict[str, str] = {}
    for line in names.splitlines():
        spellings = line.split()
        for spelling in spellings:
            table[spelling] = spellings[0]
    return table


GENERAL_CATEGORIES = _spellings(
    """\
Cased_Letter LC
Close_Punctuation Pe
Connector_Punctuation Pc
Control Cc cntrl
Currency_Symbol Sc
Dash_Punctuation Pd
Decimal_Number Nd digit
Enclosing_Mark Me
Final_Punctuation Pf
Format Cf
Initial_Punctuation Pi
Letter L
Letter_Number Nl
Line_Separator Zl
Lowercase_Letter Ll
Mark M Combining_Mark
Math_Symbol Sm
Modifier_Letter Lm
Modifier_Symbol Sk
Nonspacing_Mark Mn
Number N
Open_Punctuation Ps
Other C
Other_Letter Lo
Other_Number No
Other_Punctuation Po
Other_Symbol So
Paragraph_Separator Zp
Private_Use Co
Punctuation P punct
Separator Z
Space_Separator Zs
Spacing_Mark Mc
Surrogate Cs
Symbol S
Titlecase_Letter Lt
Unassigned Cn
Uppercase_Letter Lu
"""
)


BINARY_PROPERTIES = _spellings(
    """\
Alphabetic Alpha
Any
ASCII
ASCII_Hex_Digit AHex
Assigned
Bidi_Control Bidi_C
Bidi_Mirrored Bidi_M
Case_Ignorable CI
Cased
Changes_When_Casefolded CWCF
Changes_When_Casemapped CWCM
Changes_When_Lowercased CWL
Changes_When_NFKC_Casefolded CWKCF
Changes_When_Titlecased CWT
Changes_When_Uppercased CWU
Dash
Default_Ignorable_Code_Point DI
Deprecated Dep
Diacritic Dia
Emoji
Emoji_Component EComp
Emoji_Modifier EMod
Emoji_Modifier_Base EBase
Emoji_Presentation EPres
Extended_Pictographic ExtPict
Extender Ext
Grapheme_Base Gr_Base
Grapheme_Extend Gr_Ext
Hex_Digit Hex
ID_Continue IDC
ID_Start IDS
Ideographic Ideo
IDS_Binary_Operator IDSB
IDS_Trinary_Operator IDST
Join_Control Join_C
Logical_Order_Exception LOE
Lowercase Lower
Math
Noncharacter_Code_Point NChar
Pattern_Syntax Pat_Syn
Pattern_White_Space Pat_WS
Quotation_Mark QMark
Radical
Regional_Indicator RI
Sentence_Terminal STerm
Soft_Dotted SD
Terminal_Punctuation Term
Unified_Ideograph UIdeo
Uppercase Upper
Variation_Selector VS
White_Space WSpace space
XID_Continue XIDC
XID_Start XIDS
"""
)


SCRIPTS = _spellings(
    """\
Adlam Adlm
Ahom
Anatolian_Hieroglyphs Hluw
Arabic Arab
Armenian Armn
Avestan Avst
Balinese Bali
Bamum Bamu
Bassa_Vah Bass
Batak Batk
Bengali Beng
Beria_Erfe Berf
Bhaiksuki Bhks
Bopomofo Bopo
Brahmi Brah
Braille Brai
Buginese Bugi
Buhid Buhd
Canadian_Aboriginal Cans
Carian Cari
Caucasian_Albanian Aghb
Chakma Cakm
Cham
Cherokee Cher
Chorasmian Chrs
Common Zyyy
Coptic Copt Qaac
Cuneiform Xsux
Cypriot Cprt
Cypro_Minoan Cpmn
Cyrillic Cyrl
Deseret Dsrt
Devanagari Deva
Dives_Akuru Diak
Dogra Dogr
Duployan Dupl
Egyptian_Hieroglyphs Egyp
Elbasan Elba
Elymaic Elym
Ethiopic Ethi
Garay Gara
Georgian Geor
Glagolitic Glag
Gothic Goth
Grantha Gran
Greek Grek
Gujarati Gujr
Gunjala_Gondi Gong
Gurmukhi Guru
Gurung_Khema Gukh
Han Hani
Hangul Hang
Hanifi_Rohingya Rohg
Hanunoo Hano
Hatran Hatr
Hebrew Hebr
Hiragana Hira
Imperial_Aramaic Armi
Inherited Zinh Qaai
Inscriptional_Pahlavi Phli
Inscriptional_Parthian Prti
Javanese Java
Kaithi Kthi
Kannada Knda
Katakana Kana
Kawi
Kayah_Li Kali
Kharoshthi Khar
Khitan_Small_Script Kits
Khmer Khmr
Khojki Khoj
Khudawadi Sind
Kirat_Rai Krai
Lao Laoo
Latin Latn
Lepcha Lepc
Limbu Limb
Linear_A Lina
Linear_B Linb
Lisu
Lycian Lyci
Lydian Lydi
Mahajani Mahj
Makasar Maka
Malayalam Mlym
Mandaic Mand
Manichaean Mani
Marchen Marc
Masaram_Gondi Gonm
Medefaidrin Medf
Meetei_Mayek Mtei
Mende_Kikakui Mend
Meroitic_Cursive Merc
Meroitic_Hieroglyphs Mero
Miao Plrd
Modi
Mongolian Mong
Mro Mroo
Multani Mult
Myanmar Mymr
Nabataean Nbat
Nag_Mundari Nagm
Nandinagari Nand
New_Tai_Lue Talu
Newa
Nko Nkoo
Nushu Nshu
Nyiakeng_Puachue_Hmong Hmnp
Ogham Ogam
Ol_Chiki Olck
Ol_Onal Onao
Old_Hungarian Hung
Old_Italic Ital
Old_North_Arabian Narb
Old_Permic Perm
Old_Persian Xpeo
Old_Sogdian Sogo
Old_South_Arabian Sarb
Old_Turkic Orkh
Old_Uyghur Ougr
Oriya Orya
Osage Osge
Osmanya Osma
Pahawh_Hmong Hmng
Palmyrene Palm
Pau_Cin_Hau Pauc
Phags_Pa Phag
Phoenician Phnx
Psalter_Pahlavi Phlp
Rejang Rjng
Runic Runr
Samaritan Samr
Saurashtra Saur
Sharada Shrd
Shavian Shaw
Siddham Sidd
Sidetic Sidt
SignWriting Sgnw
Sinhala Sinh
Sogdian Sogd
Sora_Sompeng Sora
Soyombo Soyo
Sundanese Sund
Sunuwar Sunu
Syloti_Nagri Sylo
Syriac Syrc
Tagalog Tglg
Tagbanwa Tagb
Tai_Le Tale
Tai_Tham Lana
Tai_Viet Tavt
Tai_Yo Tayo
Takri Takr
Tamil Taml
Tangsa Tnsa
Tangut Tang
Telugu Telu
Thaana Thaa
Thai
Tibetan Tibt
Tifinagh Tfng
Tirhuta Tirh
Todhri Todr
Tolong_Siki Tols
Toto
Tulu_Tigalari Tutg
Ugaritic Ugar
Unknown Zzzz
Vai Vaii
Vithkuqi Vith
Wancho Wcho
Warang_Citi Wara
Yezidi Yezi
Yi Yiii
Zanabazar_Square Zanb
"""
)

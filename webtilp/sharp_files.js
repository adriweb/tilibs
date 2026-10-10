/* Sharp PC-Link file codecs. Format/token provenance: docs/SHARP_PROTOCOL.md.
 * Token spellings are protocol data; no Sharp executable or font is shipped.
 */
(function (scope) {
'use strict';
const native = typeof module === 'object' && module.exports ? require('./sharp_backend.js') : scope.WebTILPSharp;
// [wire bytes, Unicode spelling, official PC-Link TXT spelling], in the
// converter's bank order (ties in longest matching spellings keep this order).
const TOKENS = [
    ["17", "a", "@a@"],
    ["18", "b", "@b@"],
    ["19", "c", "@c@"],
    ["1A", "d", "@d@"],
    ["1B", "e", "@e@"],
    ["1C", "r", "@r@"],
    ["1D", "r²", "@r@@^2@"],
    ["1E", "R²", "@R@@^2@"],
    ["1F", "n", "@n@"],
    ["20", " ", " "],
    ["21", ".", "."],
    ["22", "ᴇ", "@EE@"],
    ["23", "−", "@-@"],
    ["24", "°", "@deg@"],
    ["25", "'", "'"],
    ["26", "\"", "\""],
    ["27", "ʳ", "@rad@"],
    ["28", "i", "@i@"],
    ["29", "∠", "@complex_angle@"],
    ["2A", "(", "("],
    ["2B", ")", ")"],
    ["2C", "{", "{"],
    ["2D", "}", "}"],
    ["2E", "[", "["],
    ["2F", "]", "]"],
    ["30", "0", "0"],
    ["31", "1", "1"],
    ["32", "2", "2"],
    ["33", "3", "3"],
    ["34", "4", "4"],
    ["35", "5", "5"],
    ["36", "6", "6"],
    ["37", "7", "7"],
    ["38", "8", "8"],
    ["39", "9", "9"],
    ["41", "A", "A"],
    ["42", "B", "B"],
    ["43", "C", "C"],
    ["44", "D", "D"],
    ["45", "E", "E"],
    ["46", "F", "F"],
    ["47", "G", "G"],
    ["48", "H", "H"],
    ["49", "I", "I"],
    ["4A", "J", "J"],
    ["4B", "K", "K"],
    ["4C", "L", "L"],
    ["4D", "M", "M"],
    ["4E", "N", "N"],
    ["4F", "O", "O"],
    ["50", "P", "P"],
    ["51", "Q", "Q"],
    ["52", "R", "R"],
    ["53", "S", "S"],
    ["54", "T", "T"],
    ["55", "U", "U"],
    ["56", "V", "V"],
    ["57", "W", "W"],
    ["58", "X", "X"],
    ["59", "Y", "Y"],
    ["5A", "Z", "Z"],
    ["5B", "θ", "@theta@"],
    ["5C", "Ans", "Ans"],
    ["5D", "π", "@pi@"],
    ["5E", ":", ":"],
    ["5F", ",", ","],
    ["60", "=", "="],
    ["61", "≠", "@not_=@"],
    ["62", ">", ">"],
    ["63", "≥", "@>=@"],
    ["64", "<", "<"],
    ["65", "≤", "@<=@"],
    ["66", "and ", "and "],
    ["67", "or ", "or "],
    ["68", "xor ", "xor "],
    ["69", "xnor ", "xnor "],
    ["6A", "not ", "not "],
    ["6B", "neg ", "neg "],
    ["6D", "e", "e"],
    ["70", "*", "*"],
    ["71", "/", "/"],
    ["72", "+", "+"],
    ["73", "-", "-"],
    ["74", "@x@√", "@x@@root@"],
    ["75", "⌟", "@frac@"],
    ["76", "^", "^"],
    ["77", " nPr ", "@Per@"],
    ["78", " nCr ", "@Com@"],
    ["79", "²", "@^2@"],
    ["7A", "⁻¹", "@^-1@"],
    ["7B", "!", "!"],
    ["7C", "→", "@sto@"],
    ["7D", "x'", "x'"],
    ["7E", "y'", "y'"],
    ["7F", "➔deg", "@->@deg"],
    ["80", "➔dms", "@->@dms"],
    ["81", "√", "@root@"],
    ["82", "log ", "log "],
    ["83", "ln ", "ln "],
    ["84", "log₂ ", "log@2@ "],
    ["85", "₁₀^", "@10@^"],
    ["86", "e^", "e^"],
    ["87", "2^", "2^"],
    ["88", "sin ", "sin "],
    ["89", "cos ", "cos "],
    ["8A", "tan ", "tan "],
    ["8B", "sin⁻¹ ", "sin@^-1@ "],
    ["8C", "cos⁻¹ ", "cos@^-1@ "],
    ["8D", "tan⁻¹ ", "tan@^-1@ "],
    ["8E", "sinh ", "sinh "],
    ["8F", "cosh ", "cosh "],
    ["90", "tanh ", "tanh "],
    ["91", "sinh⁻¹ ", "sinh@^-1@ "],
    ["92", "cosh⁻¹ ", "cosh@^-1@ "],
    ["93", "tanh⁻¹ ", "tanh@^-1@ "],
    ["94", "sec ", "sec "],
    ["95", "csc ", "csc "],
    ["96", "cot ", "cot "],
    ["97", "sec⁻¹ ", "sec@^-1@ "],
    ["98", "csc⁻¹ ", "csc@^-1@ "],
    ["99", "cot⁻¹ ", "cot@^-1@ "],
    ["9A", "int ", "int "],
    ["9B", "ipart ", "ipart "],
    ["9C", "fpart ", "fpart "],
    ["9D", "cumul ", "cumul "],
    ["9E", "df_list ", "df_list "],
    ["9F", "augment(", "augment("],
    ["A0", "seq(", "seq("],
    ["A1", "xy➔r(", "xy@->@r("],
    ["A2", "xy➔θ(", "xy@->@@theta@("],
    ["A3", "rθ➔x(", "r@theta@@->@x("],
    ["A4", "rθ➔y(", "r@theta@@->@y("],
    ["A5", "abs(", "abs("],
    ["A6", "d/dx(", "d/dx("],
    ["A7", "fmin(", "fmin("],
    ["A8", "fmax(", "fmax("],
    ["A9", "min(", "min("],
    ["AA", "max(", "max("],
    ["AB", "mean(", "mean("],
    ["AC", "median(", "median("],
    ["AD", "sum(", "sum("],
    ["AE", "prod(", "prod("],
    ["AF", "stdDv(", "stdDv("],
    ["B0", "varian(", "varian("],
    ["B1", "lcm(", "lcm("],
    ["B2", "gcd(", "gcd("],
    ["B3", "%", "%"],
    ["B6", "round(", "round("],
    ["B7", "Σ(", "@SIGMA@("],
    ["B8", "conj(", "conj("],
    ["B9", "real(", "real("],
    ["BA", "image(", "image("],
    ["BB", "arg(", "arg("],
    ["BC", "∫", "@integral@"],
    ["BD", "dx", "dx"],
    ["BE", "random ", "random "],
    ["BF", "ᵍ", "@grad@"],
    ["C0", "n", "n"],
    ["C1", "n₁", "n@1@"],
    ["C2", "n₂", "n@2@"],
    ["C3", "x̄", "@x_mean@"],
    ["C4", "x̄₁", "@x_mean@@1@"],
    ["C5", "x̄₂", "@x_mean@@2@"],
    ["C6", "sx", "sx"],
    ["C7", "sx₁", "sx@1@"],
    ["C8", "sx₂", "sx@2@"],
    ["C9", "sxp", "sxp"],
    ["CA", "σx", "@sigma@x"],
    ["CB", "xmin", "xmin"],
    ["CC", "xmax", "xmax"],
    ["CD", "Σx", "@SIGMA@x"],
    ["CE", "Σx²", "@SIGMA@x@^2@"],
    ["CF", "Σxy", "@SIGMA@xy"],
    ["D0", "ȳ", "@y_mean@"],
    ["D1", "sy", "sy"],
    ["D2", "σy", "@sigma@y"],
    ["D3", "ymin", "ymin"],
    ["D4", "ymax", "ymax"],
    ["D5", "Σy", "@SIGMA@y"],
    ["D6", "Σy²", "@SIGMA@y@^2@"],
    ["D9", "p", "p"],
    ["DE", "z", "z"],
    ["DF", "t", "t"],
    ["E0", "χ²", "@chi@@^2@"],
    ["E1", "F", "@stat_F@"],
    ["E2", "df", "df"],
    ["E4", "p̂", "@p_hat@"],
    ["E5", "p̂₁", "@p_hat@@1@"],
    ["E6", "p̂₂", "@p_hat@@2@"],
    ["E7", "s", "s"],
    ["EE", "lower", "lower"],
    ["EF", "upper", "upper"],
    ["F0", "x₁", "x@1@"],
    ["F1", "x₂", "x@2@"],
    ["F2", "x₃", "x@3@"],
    ["F3", "y₁", "y@1@"],
    ["F4", "y₂", "y@2@"],
    ["F5", "y₃", "y@3@"],
    ["F6", "Q₁", "Q@1@"],
    ["F7", "Med", "Med"],
    ["F8", "Q₃", "Q@3@"],
    ["F9", "C-Level", "C-Level"],
    ["FA", "prop", "prop"],
    ["FB", "@unit@", "@unit@"],
    ["FD", "\n", "\n"],
    ["0510", "Hist", "Hist"],
    ["0511", "Broken·", "Broken@dot@"],
    ["0512", "Broken×", "Broken@cross@"],
    ["0513", "Broken□", "Broken@box@"],
    ["0514", "Norm·_x", "Norm@dot@_x"],
    ["0515", "Norm×_x", "Norm@cross@_x"],
    ["0516", "Norm□_x", "Norm@box@_x"],
    ["0517", "Norm·_y", "Norm@dot@_y"],
    ["0518", "Norm×_y", "Norm@cross@_y"],
    ["0519", "Norm□_y", "Norm@box@_y"],
    ["051A", "NormDis", "NormDis"],
    ["051B", "Box", "Box"],
    ["051C", "MBox·", "MBox@dot@"],
    ["051D", "MBox×", "MBox@cross@"],
    ["051E", "MBox□", "MBox@box@"],
    ["051F", "Scattr·", "Scattr@dot@"],
    ["0520", "Scattr×", "Scattr@cross@"],
    ["0521", "Scattr□", "Scattr@box@"],
    ["0522", "xyLine·", "xyLine@dot@"],
    ["0523", "xyLine×", "xyLine@cross@"],
    ["0524", "xyLine□", "xyLine@box@"],
    ["0525", "Pie", "Pie"],
    ["0526", "Pie%", "Pie%"],
    ["0710", "Xmin", "Xmin"],
    ["0711", "Xmax", "Xmax"],
    ["0712", "Xscl", "Xscl"],
    ["0713", "Ymin", "Ymin"],
    ["0714", "Ymax", "Ymax"],
    ["0715", "Yscl", "Yscl"],
    ["0718", "X_Fact", "X_Fact"],
    ["0719", "Y_Fact", "Y_Fact"],
    ["071A", "Zm_Xmin", "Zm_Xmin"],
    ["071B", "Zm_Xmax", "Zm_Xmax"],
    ["071C", "Zm_Xscl", "Zm_Xscl"],
    ["071D", "Zm_Ymin", "Zm_Ymin"],
    ["071E", "Zm_Ymax", "Zm_Ymax"],
    ["071F", "Zm_Yscl", "Zm_Yscl"],
    ["0720", "Tmin", "Tmin"],
    ["0721", "Tmax", "Tmax"],
    ["0722", "Tstep", "Tstep"],
    ["0723", "Zm_Tmin", "Zm_Tmin"],
    ["0724", "Zm_Tmax", "Zm_Tmax"],
    ["0725", "Zm_Tstp", "Zm_Tstp"],
    ["0726", "θmin", "@theta@min"],
    ["0727", "θmax", "@theta@max"],
    ["0728", "θstep", "@theta@step"],
    ["0729", "Zm_θmin", "Zm_@theta@min"],
    ["072A", "Zm_θmax", "Zm_@theta@max"],
    ["072B", "Zm_θstp", "Zm_@theta@stp"],
    ["0730", "nMin", "@n@Min"],
    ["0731", "nMax", "@n@Max"],
    ["0732", "PlotStart", "PlotStart"],
    ["0733", "PlotStep", "PlotStep"],
    ["0734", "Zm_nMin", "Zm_@n@Min"],
    ["0735", "Zm_nMax", "Zm_@n@Max"],
    ["0736", "Zm_PltStart", "Zm_PltStart"],
    ["0737", "Zm_PltStp", "Zm_PltStp"],
    ["0740", "TBLStrt", "TBLStrt"],
    ["0741", "TBLStep", "TBLStep"],
    ["0742", "N", "@N@"],
    ["0743", "I%", "I%"],
    ["0744", "PV", "PV"],
    ["0745", "PMT", "PMT"],
    ["0746", "FV", "FV"],
    ["0747", "P/Y", "P/Y"],
    ["0748", "C/Y", "C/Y"],
    ["0810", "L1", "L1"],
    ["0811", "L2", "L2"],
    ["0812", "L3", "L3"],
    ["0813", "L4", "L4"],
    ["0814", "L5", "L5"],
    ["0815", "L6", "L6"],
    ["0816", "TBLList", "TBLList"],
    ["0817", "resid", "resid"],
    ["0820", "u(nMin)", "u(@n@Min)"],
    ["0821", "v(nMin)", "v(@n@Min)"],
    ["0822", "w(nMin)", "w(@n@Min)"],
    ["0823", "Zm_u(nMin)", "Zm_u(@n@Min)"],
    ["0824", "Zm_v(nMin)", "Zm_v(@n@Min)"],
    ["0825", "Zm_w(nMin)", "Zm_w(@n@Min)"],
    ["0910", "mat A", "mat A"],
    ["0911", "mat B", "mat B"],
    ["0912", "mat C", "mat C"],
    ["0913", "mat D", "mat D"],
    ["0914", "mat E", "mat E"],
    ["0915", "mat F", "mat F"],
    ["0916", "mat G", "mat G"],
    ["0917", "mat H", "mat H"],
    ["0918", "mat I", "mat I"],
    ["0919", "mat J", "mat J"],
    ["0A10", "End", "End"],
    ["0A11", "Return", "Return"],
    ["0A12", "ClrT", "ClrT"],
    ["0A13", "ClrG", "ClrG"],
    ["0A14", "DispT", "DispT"],
    ["0A15", "DispG", "DispG"],
    ["0A16", "Rect", "Rect"],
    ["0A17", "Param", "Param"],
    ["0A18", "Polar", "Polar"],
    ["0A19", "Web", "Web"],
    ["0A1A", "Time", "Time"],
    ["0A1B", "uv", "uv"],
    ["0A1C", "uw", "uw"],
    ["0A1D", "vw", "vw"],
    ["0A1E", "RectCursor", "RectCursor"],
    ["0A1F", "PolarCursor", "PolarCursor"],
    ["0A20", "ExprON", "ExprON"],
    ["0A21", "ExprOFF", "ExprOFF"],
    ["0A22", "Y'ON", "Y'ON"],
    ["0A23", "Y'OFF", "Y'OFF"],
    ["0A24", "Connect", "Connect"],
    ["0A25", "Dot", "Dot"],
    ["0A26", "Sequen", "Sequen"],
    ["0A27", "Simul", "Simul"],
    ["0A28", "LimON", "LimON"],
    ["0A29", "LimOFF", "LimOFF"],
    ["0A2A", "PmtEnd", "PmtEnd"],
    ["0A2B", "PmtBegin", "PmtBegin"],
    ["0A2C", "InputList", "InputList"],
    ["0A2D", "InputStats", "InputStats"],
    ["0A2E", "Wait ", "Wait "],
    ["0A2F", "DrawON ", "DrawON "],
    ["0A30", "DrawOFF ", "DrawOFF "],
    ["0A31", "PlotON ", "PlotON "],
    ["0A32", "PlotOFF ", "PlotOFF "],
    ["0A33", "SetList ", "SetList "],
    ["0A34", "ClrList ", "ClrList "],
    ["0A35", "slv_pmt ", "slv_pmt "],
    ["0A36", "slv_I% ", "slv_I% "],
    ["0A37", "slv_PV ", "slv_PV "],
    ["0A38", "slv_N ", "slv_@N@ "],
    ["0A39", "slv_FV ", "slv_FV "],
    ["0A3A", "1_Stats ", "1_Stats "],
    ["0A3B", "2_Stats ", "2_Stats "],
    ["0A3C", "Med_Med ", "Med_Med "],
    ["0A3D", "Rg_ax+b ", "Rg_ax+b "],
    ["0A3E", "Rg_x² ", "Rg_x@^2@ "],
    ["0A3F", "Rg_x³ ", "Rg_x@^3@ "],
    ["0A40", "Rg_x⁴ ", "Rg_x@^4@ "],
    ["0A41", "Rg_ln ", "Rg_ln "],
    ["0A42", "Rg_log ", "Rg_log "],
    ["0A43", "Rg_ab@x@ ", "Rg_ab@x@ "],
    ["0A44", "Rg_aeᵇ@x@ ", "Rg_ae@^b@@x@ "],
    ["0A45", "Rg_x⁻¹ ", "Rg_x@^-1@ "],
    ["0A46", "Rg_axᵇ ", "Rg_ax@^b@ "],
    ["0A47", "Rg_ax", "Rg_ax"],
    ["0A49", "Rg_a+bx ", "Rg_a+bx "],
    ["0A4A", "ANOVA(", "ANOVA("],
    ["0A4B", "fill(", "fill("],
    ["0A4C", "dim(", "dim("],
    ["0A4D", "rnd_mat(", "rnd_mat("],
    ["0A4E", "row_swap(", "row_swap("],
    ["0A4F", "row_plus(", "row_plus("],
    ["0A50", "row_mult(", "row_mult("],
    ["0A51", "row_m.p.(", "row_m.p.("],
    ["0A52", "list➔mat(", "list@->@mat("],
    ["0A53", "mat➔list(", "mat@->@list("],
    ["0A54", "sortA(", "sortA("],
    ["0A55", "sortD(", "sortD("],
    ["0A56", "Npv(", "Npv("],
    ["0A57", "Irr(", "Irr("],
    ["0A58", "Bal(", "Bal("],
    ["0A59", "ΣPrn(", "@SIGMA@Prn("],
    ["0A5A", "ΣInt(", "@SIGMA@Int("],
    ["0A5B", "➔Apr(", "@->@Apr("],
    ["0A5C", "➔Eff(", "@->@Eff("],
    ["0A5D", "days(", "days("],
    ["0A5E", "Rg_logistic ", "Rg_logistic "],
    ["0A5F", "Rg_sin ", "Rg_sin "],
    ["0A60", "remain", "remain"],
    ["0A61", "int@glyphB6@", "int@glyphB6@"],
    ["0A62", "Shade(", "Shade("],
    ["0A63", "PxlON(", "PxlON("],
    ["0A64", "PxlOFF(", "PxlOFF("],
    ["0A65", "PxlCHG(", "PxlCHG("],
    ["0A66", "PxlTST(", "PxlTST("],
    ["0A67", "rndInt(", "rndInt("],
    ["0A68", "rndCoin ", "rndCoin "],
    ["0A69", "rndDice ", "rndDice "],
    ["0A6B", "Plt1(", "Plt1("],
    ["0A6C", "Plt2(", "Plt2("],
    ["0A6D", "Plt3(", "Plt3("],
    ["0A6E", "cdfnorm(", "cdfnorm("],
    ["0A6F", "cdfT(", "cdfT("],
    ["0A70", "cdfχ²(", "cdf@chi@@^2@("],
    ["0A71", "cdfF(", "cdf@stat_F@("],
    ["0A72", "cdfbin(", "cdfbin("],
    ["0A73", "cdfpoi(", "cdfpoi("],
    ["0A74", "cdfgeo(", "cdfgeo("],
    ["0A75", "InvNorm(", "InvNorm("],
    ["0A76", "Print ", "Print "],
    ["0A77", "Input ", "Input "],
    ["0A78", "Rem ", "Rem "],
    ["0A79", "Label ", "Label "],
    ["0A7A", "Goto ", "Goto "],
    ["0A7B", "If ", "If "],
    ["0A7C", "Gosub ", "Gosub "],
    ["0A7D", "Send ", "Send "],
    ["0A7E", "Get ", "Get "],
    ["0A7F", "identity ", "identity "],
    ["0A80", "det ", "det "],
    ["0A81", "trans ", "trans "],
    ["0A82", "rowEF ", "rowEF "],
    ["0A83", "rrowEF ", "rrowEF "],
    ["0A84", "StoPict ", "StoPict "],
    ["0A85", "RclPict ", "RclPict "],
    ["0A86", "StoGD ", "StoGD "],
    ["0A87", "RclGD ", "RclGD "],
    ["0A88", "StoLD ", "StoLD "],
    ["0A89", "RclLD ", "RclLD "],
    ["0A8A", "Draw ", "Draw "],
    ["0A8B", "DrawInv ", "DrawInv "],
    ["0A8C", "Simp ", "Simp "],
    ["0A8D", "➔A.xxx", "@->@A.xxx"],
    ["0A8E", "➔a@unit@b/c", "@->@a@unit@b/c"],
    ["0A8F", "➔b/c", "@->@b/c"],
    ["0A90", "ClrDraw", "ClrDraw"],
    ["0A91", "Line(", "Line("],
    ["0A92", "T_line(", "T_line("],
    ["0A93", "Circle(", "Circle("],
    ["0A94", "Text(", "Text("],
    ["0A95", "PntON(", "PntON("],
    ["0A96", "PntOFF(", "PntOFF("],
    ["0A97", "PntCHG(", "PntCHG("],
    ["0A98", "H_line ", "H_line "],
    ["0A99", "V_line ", "V_line "],
    ["0A9A", "N_line(", "N_line("],
    ["0AA0", "pdfnorm(", "pdfnorm("],
    ["0AA1", "pdfT(", "pdfT("],
    ["0AA2", "pdfχ²(", "pdf@chi@@^2@("],
    ["0AA3", "pdfF(", "pdf@stat_F@("],
    ["0AA4", "pdfbin(", "pdfbin("],
    ["0AA5", "pdfpoi(", "pdfpoi("],
    ["0AA6", "pdfgeo(", "pdfgeo("],
    ["0AAB", "P_stdDv(", "P_stdDv("],
    ["0AAC", "rndNorm(", "rndNorm("],
    ["0AAD", "rndBin(", "rndBin("],
    ["0AAE", "CrossPro(", "CrossPro("],
    ["0AAF", "DotPro(", "DotPro("],
    ["0AB1", "For ", "For "],
    ["0AB2", "Next", "Next"],
    ["0AB3", "Then ", "Then "],
    ["0AB4", "Else ", "Else "],
    ["0AB5", "EndIf", "EndIf"],
    ["0AB6", "While ", "While "],
    ["0AB7", "WEnd", "WEnd"],
    ["0AB8", "Key ", "Key "],
    ["0AC0", "Tab ", "Tab "],
    ["0AC1", "Deg", "Deg"],
    ["0AC2", "Rad", "Rad"],
    ["0AC3", "Grad", "Grad"],
    ["0AC4", "FloatPt", "FloatPt"],
    ["0AC5", "Fix", "Fix"],
    ["0AC6", "Sci", "Sci"],
    ["0AC7", "Eng", "Eng"],
    ["0AC8", "Decimal", "Decimal"],
    ["0AC9", "Mixed", "Mixed"],
    ["0ACA", "Improp", "Improp"],
    ["0ACB", "x@glyphCF@yi", "x@glyphCF@yi"],
    ["0ACC", "r∠θ", "r@complex_angle@@theta@"],
    ["0AD0", "AxisON", "AxisON"],
    ["0AD1", "AxisOFF", "AxisOFF"],
    ["0AD2", "GridON", "GridON"],
    ["0AD3", "GridOFF", "GridOFF"],
    ["0B10", "Zm_Box", "Zm_Box"],
    ["0B11", "Zm_In", "Zm_In"],
    ["0B12", "Zm_Out", "Zm_Out"],
    ["0B13", "Zm_Default", "Zm_Default"],
    ["0B14", "Zm_Square", "Zm_Square"],
    ["0B15", "Zm_Dec", "Zm_Dec"],
    ["0B16", "Zm_Int", "Zm_Int"],
    ["0B17", "Zm_Stat", "Zm_Stat"],
    ["0B18", "Zm_Auto", "Zm_Auto"],
    ["0B19", "Zm_x⁻¹", "Zm_x@^-1@"],
    ["0B1A", "Zm_x²", "Zm_x@^2@"],
    ["0B1B", "Zm_√", "Zm_@root@"],
    ["0B1C", "Zm_₁₀@x@", "Zm_@10@@x@"],
    ["0B1D", "Zm_e@x@", "Zm_e@x@"],
    ["0B1E", "Zm_log", "Zm_log"],
    ["0B1F", "Zm_ln", "Zm_ln"],
    ["0B20", "Zm_sin", "Zm_sin"],
    ["0B21", "Zm_cos", "Zm_cos"],
    ["0B22", "Zm_tan", "Zm_tan"],
    ["0B23", "Zm_sin⁻¹", "Zm_sin@^-1@"],
    ["0B24", "Zm_cos⁻¹", "Zm_cos@^-1@"],
    ["0B25", "Zm_tan⁻¹", "Zm_tan@^-1@"],
    ["0B26", "Zm_sinh", "Zm_sinh"],
    ["0B27", "Zm_cosh", "Zm_cosh"],
    ["0B28", "Zm_tanh", "Zm_tanh"],
    ["0B29", "Zm_sinh⁻¹", "Zm_sinh@^-1@"],
    ["0B2A", "Zm_cosh⁻¹", "Zm_cosh@^-1@"],
    ["0B2B", "Zm_tanh⁻¹", "Zm_tanh@^-1@"],
    ["0B2C", "PreWin", "PreWin"],
    ["0B2D", "StoWin", "StoWin"],
    ["0B2E", "RclWin", "RclWin"],
    ["0B30", "Intsct", "Intsct"],
    ["0B31", "Minimum", "Minimum"],
    ["0B32", "Maximum", "Maximum"],
    ["0B33", "X_Incpt", "X_Incpt"],
    ["0B34", "Y_zero", "Y_zero"],
    ["0B35", "Value ", "Value "],
    ["0B36", "Inflec", "Inflec"],
    ["0B37", "∫dx", "@integral@dx"],
    ["0B40", "TRACE", "TRACE"],
    ["0C10", "Y1", "Y1"],
    ["0C11", "Y2", "Y2"],
    ["0C12", "Y3", "Y3"],
    ["0C13", "Y4", "Y4"],
    ["0C14", "Y5", "Y5"],
    ["0C15", "Y6", "Y6"],
    ["0C16", "Y7", "Y7"],
    ["0C17", "Y8", "Y8"],
    ["0C18", "Y9", "Y9"],
    ["0C19", "Y0", "Y0"],
    ["0C20", "X1T", "X1T"],
    ["0C21", "Y1T", "Y1T"],
    ["0C22", "X2T", "X2T"],
    ["0C23", "Y2T", "Y2T"],
    ["0C24", "X3T", "X3T"],
    ["0C25", "Y3T", "Y3T"],
    ["0C26", "X4T", "X4T"],
    ["0C27", "Y4T", "Y4T"],
    ["0C28", "X5T", "X5T"],
    ["0C29", "Y5T", "Y5T"],
    ["0C2A", "X6T", "X6T"],
    ["0C2B", "Y6T", "Y6T"],
    ["0C30", "R1", "R1"],
    ["0C31", "R2", "R2"],
    ["0C32", "R3", "R3"],
    ["0C33", "R4", "R4"],
    ["0C34", "R5", "R5"],
    ["0C35", "R6", "R6"],
    ["0C40", "u(n)", "u(@n@)"],
    ["0C41", "v(n)", "v(@n@)"],
    ["0C42", "w(n)", "w(@n@)"],
    ["0C43", "u", "u"],
    ["0C44", "v", "v"],
    ["0C45", "w", "w"],
    ["0D10", "Pict1", "Pict1"],
    ["0D11", "Pict2", "Pict2"],
    ["0D12", "Pict3", "Pict3"],
    ["0D13", "Pict4", "Pict4"],
    ["0D14", "Pict5", "Pict5"],
    ["0D15", "Pict6", "Pict6"],
    ["0D16", "Pict7", "Pict7"],
    ["0D17", "Pict8", "Pict8"],
    ["0D18", "Pict9", "Pict9"],
    ["0D19", "Pict0", "Pict0"],
    ["0D20", "G_Data1", "G_Data1"],
    ["0D21", "G_Data2", "G_Data2"],
    ["0D22", "G_Data3", "G_Data3"],
    ["0D23", "G_Data4", "G_Data4"],
    ["0D24", "G_Data5", "G_Data5"],
    ["0D25", "G_Data6", "G_Data6"],
    ["0D26", "G_Data7", "G_Data7"],
    ["0D27", "G_Data8", "G_Data8"],
    ["0D28", "G_Data9", "G_Data9"],
    ["0D29", "G_Data0", "G_Data0"],
    ["0D30", "L_Data1", "L_Data1"],
    ["0D31", "L_Data2", "L_Data2"],
    ["0D32", "L_Data3", "L_Data3"],
    ["0D33", "L_Data4", "L_Data4"],
    ["0D34", "L_Data5", "L_Data5"],
    ["0D35", "L_Data6", "L_Data6"],
    ["0D36", "L_Data7", "L_Data7"],
    ["0D37", "L_Data8", "L_Data8"],
    ["0D38", "L_Data9", "L_Data9"],
    ["0D39", "L_Data0", "L_Data0"]
];
const hex = data => Array.from(data, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const fromHex = value => Uint8Array.from(value.match(/../g) || [], b => parseInt(b, 16));
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
};
const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
const byteText = data => Array.from(data, b => String.fromCharCode(b)).join('').replace(/\0.*$/s, '').trimEnd();
const byCode = new Map(TOKENS.map(([code, spelling]) => [code, spelling]));
const spellings = [];
for (const [code, unicode, official] of TOKENS) {
    for (const spelling of new Set([unicode, official])) if (spelling) spellings.push({ code, spelling });
}
// Convenient unambiguous ASCII alternatives. Case stays significant, matching
// PC-Link: SIN is three variable letters, sin is a function.
for (const [spelling, code] of [['->', '7C'], ['sqrt(', '812A'], ['sqrt', '81'], ['!=', '61'], ['<=', '65'], ['>=', '63']]) {
    spellings.push({ spelling, code });
}
spellings.sort((a, b) => b.spelling.length - a.spelling.length);
function matchToken(source) {
    const raw = /^\\x\{([\da-f]{2}(?:[\da-f]{2})?)\}/i.exec(source);
    if (raw) {
        const prefix = parseInt(raw[1].slice(0, 2), 16);
        if (raw[1].length === 4 && (prefix < 5 || prefix > 15)) throw new Error('A two-byte Sharp escape must start with a token prefix (05–0F).');
        return { code: raw[1].toUpperCase(), spelling: raw[0] };
    }
    return spellings.find(item => source.startsWith(item.spelling));
}
function tokenize(source, { terminate = true } = {}) {
    source = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (source.length > native.RAM_SIZE * 20) throw new Error('Sharp source is too large.');
    const result = [];
    let lineBytes = 0, hasTerminator = false;
    for (let i = 0; i < source.length;) {
        const token = matchToken(source.slice(i));
        if (!token) {
            const before = source.slice(0, i), line = before.split('\n').length;
            throw new Error(`Unsupported Sharp source at line ${line}: ${JSON.stringify(source.slice(i, i + 16))}. Use Sharp token spellings or \\x{HH} escapes.`);
        }
        const data = fromHex(token.code);
        hasTerminator = token.code === 'FF';
        if (hasTerminator && i + token.spelling.length !== source.length) throw new Error('Sharp program terminator must be last.');
        for (const b of data) {
            if (b === 0xFD) lineBytes = 0;
            else if (b !== 0xFF && ++lineBytes > 160) throw new Error('A Sharp program line exceeds the 160-byte limit.');
            result.push(b);
        }
        i += token.spelling.length;
        if (result.length > native.RAM_SIZE - 20) throw new Error('Sharp program is too large.');
    }
    if (terminate && !hasTerminator) result.push(0xFF);
    return Uint8Array.from(result);
}
function detokenize(data, { terminated = true } = {}) {
    data = new Uint8Array(data);
    if (terminated && data.at(-1) !== 0xFF) throw new Error('Sharp program has no terminator.');
    const end = terminated ? data.length - 1 : data.length, tokens = [];
    for (let i = 0; i < end;) {
        if (data[i] === 0xFF) throw new Error('Unexpected Sharp program terminator.');
        const count = data[i] >= 5 && data[i] <= 15 && i + 1 < end ? 2 : 1;
        const code = hex(data.subarray(i, i + count));
        tokens.push({ code, spelling: byCode.get(code) }); i += count;
    }
    // Preserve aliases and adjacent letter sequences which would otherwise
    // collapse into a longer keyword when read back. Unknown bytes stay visible.
    const pieces = []; let lookahead = '';
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        let spelling = token.spelling;
        let matches = false;
        try { matches = spelling && matchToken(spelling + lookahead)?.code === token.code; } catch { /* Escape-like literal text. */ }
        if (!matches) spelling = `\\x{${token.code}}`;
        pieces.push(spelling); lookahead = (spelling + lookahead).slice(0, 128);
    }
    return pieces.reverse().join('');
}
function programFile(source, name, description = '') {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,7}$/.test(name)) throw new Error('Sharp program names must have 1–8 ASCII letters, digits or underscores, starting with a letter.');
    const selector = new Uint8Array(11); selector.set(new TextEncoder().encode(name));
    let body = tokenize(source);
    // PC-Link's source-file writer (4057A1) ends new programs with FD FF.
    // Keep the low-level tokenizer lossless for existing native programs.
    if (body.at(-2) !== 0xFD) body = concat(body.subarray(0, -1), [0xFD, 0xFF]);
    if (body.length > native.RAM_SIZE - 20) throw new Error('Sharp program is too large.');
    return concat(native.nativeHeader('p', selector, description), body);
}
function decodeGroup(data, filename = '') {
    data = new Uint8Array(data);
    if (data[0] !== 52 || ![71, 103].includes(data[1]) || (filename && !/\.g4g$/i.test(filename))) throw new Error('Invalid Sharp group header.');
    const files = []; let offset = 2;
    while (offset + 264 <= data.length) {
        const length = view(data).getUint32(offset, true);
        if (!length) {
            if (offset + 264 !== data.length || data.subarray(offset).some(b => b)) throw new Error('Invalid Sharp group terminator.');
            return files;
        }
        if (length < 264 + 54 || length > data.length - offset) throw new Error('Invalid Sharp group member length.');
        const nameBytes = data.subarray(offset + 4, offset + 264);
        if (!nameBytes.includes(0)) throw new Error('Unterminated Sharp group filename.');
        const name = byteText(nameBytes);
        if (!name || /[\\/\x00-\x1F\x7F]/.test(name) || !/\.g4[pesymidlnvzwt]$/i.test(name)) {
            throw new Error('Unsupported Sharp group member name or type.');
        }
        const member = data.slice(offset + 264, offset + length);
        const decoded = native.decodeNative(member, name);
        if (decoded.backup) throw new Error('RAM backups cannot be sent as Sharp group members.');
        files.push({ name, data: member, decoded }); offset += length;
        if (files.length > 256) throw new Error('Too many Sharp group members.');
    }
    throw new Error('Truncated Sharp group.');
}
// PICT files store 127 columns × 8 pages. The selector is little-endian
// (10..19, 0D), followed by a mode byte; screenshots instead use 132 columns.
const PICTURE_WIDTH = 127, PICTURE_HEIGHT = 64;
function pictureFile(rgba, slot = 1, description = '') {
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw new Error('Choose a Sharp picture slot from 0 to 9.');
    if (rgba.length !== PICTURE_WIDTH * PICTURE_HEIGHT * 4) throw new Error('Invalid Sharp picture pixels.');
    const selector = new Uint8Array(11); selector.set([0x10 + (slot + 9) % 10, 0x0D]);
    const bitmap = new Uint8Array(PICTURE_WIDTH * 8);
    for (let y = 0; y < PICTURE_HEIGHT; y++) for (let x = 0; x < PICTURE_WIDTH; x++) {
        const i = (y * PICTURE_WIDTH + x) * 4, alpha = rgba[i + 3] / 255;
        const luminance = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) * alpha + 255 * (1 - alpha);
        if (luminance < 128) bitmap[(y >> 3) * PICTURE_WIDTH + x] |= 1 << (y & 7);
    }
    return concat(native.nativeHeader('i', selector, description), selector.subarray(0, 2), [0], bitmap);
}
function decodePicture(data) {
    const file = native.decodeNative(data);
    if (file.category?.ext !== 'i' || data.length !== 54 + 3 + PICTURE_WIDTH * 8
        || file.selector[1] !== 0x0D || file.selector[0] < 0x10 || file.selector[0] > 0x19) throw new Error('Unsupported Sharp picture layout.');
    const bitmap = data.subarray(57), rgba = new Uint8ClampedArray(PICTURE_WIDTH * PICTURE_HEIGHT * 4);
    for (let y = 0; y < PICTURE_HEIGHT; y++) for (let x = 0; x < PICTURE_WIDTH; x++) {
        const c = bitmap[(y >> 3) * PICTURE_WIDTH + x] & (1 << (y & 7)) ? 0 : 255;
        rgba.set([c, c, c, 255], (y * PICTURE_WIDTH + x) * 4);
    }
    return { width: PICTURE_WIDTH, height: PICTURE_HEIGHT, rgba };
}
function decodeNumber(data) {
    if (data.length !== 9) throw new Error('Invalid Sharp number length.');
    const digits = Array.from(data, b => [b >> 4, b & 15]).flat();
    const flags = digits[3];
    if (digits.some((n, i) => i !== 3 && n > 9) || flags & ~3) throw new Error('Unsupported Sharp numeric encoding.');
    let exponent = digits[0] * 100 + digits[1] * 10 + digits[2];
    if (exponent > 100) exponent -= 1000;
    if (exponent < -99 || exponent > 99) throw new Error('Invalid Sharp number exponent.');
    const mantissa = digits.slice(4).join('').replace(/0+$/, '');
    const value = mantissa ? `${flags & 1 ? '-' : ''}${mantissa[0]}${mantissa.length > 1 ? '.' + mantissa.slice(1) : ''}${exponent ? 'e' + exponent : ''}` : '0';
    return value + (flags & 2 ? 'i' : '');
}
function decodeNumericValues(data, count, complex = false) {
    if (!Number.isInteger(count) || count < 0 || count > native.RAM_SIZE / 9 || data.length !== count * (complex ? 18 : 9)) throw new Error('Invalid Sharp numeric array length.');
    return Array.from({ length: count }, (_, i) => complex
        ? { real: decodeNumber(data.subarray(i * 18, i * 18 + 9)), imaginary: decodeNumber(data.subarray(i * 18 + 9, i * 18 + 18)).replace(/i$/, '') }
        : decodeNumber(data.subarray(i * 9, i * 9 + 9)));
}
function previewFile(data, filename = '') {
    data = new Uint8Array(data);
    if (data[0] === 52 && [71, 103].includes(data[1])) return { value: { type: 'Sharp group', files: decodeGroup(data, filename).map(f => {
        const preview = previewFile(f.data);
        return { filename: f.name, ...(preview.text !== undefined ? { code: preview.text } : preview.value) };
    }) } };
    const file = native.decodeNative(data, filename), ext = file.category?.ext;
    if (ext === 'p') return { text: detokenize(data.subarray(54)), language: '' };
    if (ext === 'i') return { image: decodePicture(data), value: { type: 'Sharp picture', width: PICTURE_WIDTH, height: PICTURE_HEIGHT } };
    if (ext === 'v') {
        const values = decodeNumericValues(data.subarray(54), 27, true);
        return { value: Object.fromEntries(values.map((value, i) => [i < 26 ? String.fromCharCode(65 + i) : 'θ', value])) };
    }
    if (ext === 'm' || ext === 'l') {
        const body = data.subarray(54);
        if (body.length < 7) throw new Error('Truncated Sharp matrix/list header.');
        const first = view(body).getUint16(3, true), second = view(body).getUint16(5, true);
        if (ext === 'l') {
            if (second !== 1 && second !== 2) throw new Error('Unsupported Sharp list number format.');
            return { value: { type: 'Sharp list', values: decodeNumericValues(body.subarray(7), first, second === 2) } };
        }
        const values = decodeNumericValues(body.subarray(7), first * second);
        return { value: { type: 'Sharp matrix', rows: second, columns: first,
            values: Array.from({ length: second }, (_, row) => Array.from({ length: first }, (_, column) => values[column * second + row])) } };
    }
    return { value: { type: file.category?.name || 'RAM backup', description: file.description,
        bytes: data.length - 54, hex: hex(data.subarray(54)) } };
}
const api = { tokenize, detokenize, programFile, decodeGroup, pictureFile, decodePicture, decodeNumber, previewFile,
    PICTURE_WIDTH, PICTURE_HEIGHT };
if (typeof module === 'object' && module.exports) module.exports = api;
scope.WebTILPSharpFiles = api;
})(globalThis);

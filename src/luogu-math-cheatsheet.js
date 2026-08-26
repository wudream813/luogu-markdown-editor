/**
 * KaTeX Formula Assistant & Cheatsheet Library (LaTeX 数学公式面板与速查库)
 */

(function (global) {
  'use strict';

  const LuoguMathLibrary = [
    {
      category: '常用与基础 (Common)',
      items: [
        { label: '行内变量 $x$', code: '$x$', desc: '普通行内数学符号' },
        { label: '上标 (幂) $x^2$', code: 'x^{2}', desc: '上标' },
        { label: '下标 (角标) $a_i$', code: 'a_{i}', desc: '下标' },
        { label: '上标与下标 $x_i^2$', code: 'x_{i}^{2}', desc: '同时包含角标与幂' },
        { label: '分数 \\frac{a}{b}', code: '\\frac{a}{b}', desc: '标准分数' },
        { label: '大型分数 \\displaystyle', code: '\\displaystyle\\frac{a}{b}', desc: '显示模式大分数' },
        { label: '开平方根 \\sqrt{x}', code: '\\sqrt{x}', desc: '平方根' },
        { label: '开 n 次方根 \\sqrt[n]{x}', code: '\\sqrt[n]{x}', desc: 'n 次方根' },
        { label: '时间复杂度 O(n log n)', code: '\\mathcal{O}(n \\log n)', desc: '算法大 O 表示法' },
        { label: '行间独立公式 $$...$$', code: '$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$', desc: '单独成行居中公式', isWide: true }
      ]
    },
    {
      category: '关系符与运算符 (Operators)',
      items: [
        { label: '小于等于 ≤', code: '\\le', desc: '小于等于' },
        { label: '大于等于 ≥', code: '\\ge', desc: '大于等于' },
        { label: '不等于 ≠', code: '\\ne', desc: '不等于' },
        { label: '恒等于 ≡', code: '\\equiv', desc: '同余 / 恒等于' },
        { label: '约等于 ≈', code: '\\approx', desc: '近似约等于' },
        { label: '乘号 ×', code: '\\times', desc: '乘法符号' },
        { label: '点乘 ·', code: '\\cdot', desc: '点乘' },
        { label: '除号 ÷', code: '\\div', desc: '除法' },
        { label: '正负号 ±', code: '\\pm', desc: '正负号' },
        { label: '负正号 ∓', code: '\\mp', desc: '负正号' },
        { label: '取模 bmod', code: '\\bmod', desc: '取模' },
        { label: '异或 ⊕', code: '\\oplus', desc: '按位异或' },
        { label: '同或 ⊗', code: '\\otimes', desc: '张量积/同或' },
        { label: '逻辑与 ∧', code: '\\land', desc: '逻辑与' },
        { label: '逻辑或 ∨', code: '\\lor', desc: '逻辑或' },
        { label: '属于 ∈', code: '\\in', desc: '集合属于' },
        { label: '不属于 ∉', code: '\\notin', desc: '不属于' },
        { label: '包含于 ⊆', code: '\\subseteq', desc: '子集' },
        { label: '真子集 ⊂', code: '\\subset', desc: '真子集' },
        { label: '交集 ∩', code: '\\cap', desc: '交集' },
        { label: '并集 ∪', code: '\\cup', desc: '并集' },
        { label: '垂直 ⊥', code: '\\perp', desc: '垂直' },
        { label: '平行 ∥', code: '\\parallel', desc: '平行' },
        { label: '整除 |', code: '\\mid', desc: '整除' }
      ]
    },
    {
      category: '希腊字母 (Greek Letters)',
      items: [
        { label: 'α (alpha)', code: '\\alpha', desc: 'alpha' },
        { label: 'β (beta)', code: '\\beta', desc: 'beta' },
        { label: 'γ (gamma)', code: '\\gamma', desc: 'gamma' },
        { label: 'δ (delta)', code: '\\delta', desc: 'delta' },
        { label: 'ε (epsilon)', code: '\\epsilon', desc: 'epsilon' },
        { label: 'ζ (zeta)', code: '\\zeta', desc: 'zeta' },
        { label: 'η (eta)', code: '\\eta', desc: 'eta' },
        { label: 'θ (theta)', code: '\\theta', desc: 'theta' },
        { label: 'λ (lambda)', code: '\\lambda', desc: 'lambda' },
        { label: 'μ (mu)', code: '\\mu', desc: 'mu' },
        { label: 'π (pi)', code: '\\pi', desc: 'pi' },
        { label: 'ρ (rho)', code: '\\rho', desc: 'rho' },
        { label: 'σ (sigma)', code: '\\sigma', desc: 'sigma' },
        { label: 'τ (tau)', code: '\\tau', desc: 'tau' },
        { label: 'φ (varphi)', code: '\\varphi', desc: 'varphi' },
        { label: 'ω (omega)', code: '\\omega', desc: 'omega' },
        { label: 'Δ (Delta)', code: '\\Delta', desc: '大写 Delta' },
        { label: 'Θ (Theta)', code: '\\Theta', desc: '大写 Theta' },
        { label: 'Λ (Lambda)', code: '\\Lambda', desc: '大写 Lambda' },
        { label: 'Σ (Sigma)', code: '\\Sigma', desc: '大写 Sigma' },
        { label: 'Φ (Phi)', code: '\\Phi', desc: '大写 Phi' },
        { label: 'Ω (Omega)', code: '\\Omega', desc: '大写 Omega' }
      ]
    },
    {
      category: '求和、乘积与微积分 (Sum & Calculus)',
      items: [
        { label: '求和 ∑', code: '\\sum_{i=1}^{n}', desc: '求和符号' },
        { label: '连乘 ∏', code: '\\prod_{i=1}^{n}', desc: '连乘符号' },
        { label: '极限 lim', code: '\\lim_{x \\to \\infty}', desc: '极限' },
        { label: '定积分 ∫', code: '\\int_{a}^{b} f(x) \\mathrm{d}x', desc: '定积分' },
        { label: '不定积分 ∫', code: '\\int f(x) \\mathrm{d}x', desc: '不定积分' },
        { label: '二重积分 ∬', code: '\\iint_D f(x,y) \\mathrm{d}x \\mathrm{d}y', desc: '二重积分' },
        { label: '偏导数 ∂', code: '\\frac{\\partial y}{\\partial x}', desc: '偏导数' },
        { label: '无穷大 ∞', code: '\\infty', desc: '无穷大' },
        { label: '趋近于 →', code: '\\to', desc: '趋近于' }
      ]
    },
    {
      category: '矩阵与多行方程 (Matrices & Cases)',
      items: [
        {
          label: '分段函数 cases',
          code: '$$\nf(x) = \\begin{cases}\n  2, & x > 0 \\\\\n  1, & x = 0 \\\\\n  0, & x < 0\n\\end{cases}\n$$',
          desc: '分段函数',
          isWide: true
        },
        {
          label: '圆括号矩阵 pmatrix (2x2)',
          code: '$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$',
          desc: '圆括号矩阵',
          isWide: true
        },
        {
          label: '方括号矩阵 bmatrix (2x2)',
          code: '$$\n\\begin{bmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{bmatrix}\n$$',
          desc: '方括号矩阵',
          isWide: true
        },
        {
          label: '多行公式对齐 aligned',
          code: '$$\n\\begin{aligned}\na + b &= c \\\\\n(x + y)^2 &= x^2 + 2xy + y^2\n\\end{aligned}\n$$',
          desc: '多行等号对齐',
          isWide: true
        }
      ]
    },
    {
      category: '字体、字号与修饰 (Fonts & Styles)',
      items: [
        { label: '实数集 R', code: '\\mathbb{R}', desc: '实数集' },
        { label: '整数集 Z', code: '\\mathbb{Z}', desc: '整数集' },
        { label: '自然数集 N', code: '\\mathbb{N}', desc: '自然数集' },
        { label: '复数集 C', code: '\\mathbb{C}', desc: '复数集' },
        { label: '算法复杂度 O(n)', code: '\\mathcal{O}(n)', desc: '花体大 O' },
        { label: '哥特体 g', code: '\\mathfrak{g}', desc: '哥特字体' },
        { label: '手写花体 L', code: '\\mathscr{L}', desc: '手写花体' },
        { label: '公式内正体中文', code: '\\text{满足条件 } x > 0', desc: '公式中文文本' },
        { label: '加粗 \\mathbf', code: '\\mathbf{v}', desc: '向量加粗' },
        { label: '向量箭头 \\vec', code: '\\vec{a}', desc: '向量箭头' },
        { label: '上横线 \\overline', code: '\\overline{AB}', desc: '线段/平均值' },
        { label: '洛谷蓝颜色', code: '{\\color{#3498db} x}', desc: '自定义颜色' },
        { label: '红色字体', code: '{\\color{red} x}', desc: '红色' },
        { label: '绿色通过颜色', code: '{\\color{#2ecc71} \\text{AC}}', desc: '绿色' },
        { label: '特大字号 Huge', code: '{\\Huge x}', desc: 'Huge 字号' },
        { label: '大字号 Large', code: '{\\Large x}', desc: 'Large 字号' }
      ]
    }
  ];

  global.LuoguMathLibrary = LuoguMathLibrary;
  if (typeof window !== 'undefined') {
    window.LuoguMathLibrary = LuoguMathLibrary;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LuoguMathLibrary };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));

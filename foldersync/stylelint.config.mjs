// Stylelint for the window's stylesheet. Rules that only enforce a style, or
// don't fit CSS modules' camelCase class names, are turned off.
const off = [
  'alpha-value-notation',
  'at-rule-empty-line-before',
  'color-function-notation',
  'comment-empty-line-before',
  'custom-property-pattern',
  'declaration-block-no-redundant-longhand-properties',
  'declaration-empty-line-before',
  'font-family-name-quotes',
  'font-family-no-missing-generic-family-keyword',
  'function-name-case',
  'function-url-quotes',
  'length-zero-no-unit',
  'no-descending-specificity',
  'no-duplicate-selectors',
  'no-invalid-position-at-import-rule',
  'property-no-vendor-prefix',
  'rule-empty-line-before',
  'selector-class-pattern',
  'selector-pseudo-element-colon-notation',
  'selector-type-no-unknown',
  'shorthand-property-no-redundant-values',
  'value-no-vendor-prefix',
];

export default {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-css-modules'],
  rules: {
    ...Object.fromEntries(off.map((rule) => [rule, null])),
    'css-modules/composed-class-names': true,
  },
};

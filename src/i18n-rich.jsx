import React, { Fragment } from 'react';
import { t } from './i18n.mjs';

// t() for a sentence that holds elements: rich('Owned by {name}.', { name: <b>{name}</b> }) translates the whole
// sentence and puts each element where its placeholder is, so word order can change between languages.
export function rich(text, values) {
  return t(text).split(/(\{\w+\})/).map((piece, index) => {
    const key = /^\{(\w+)\}$/.exec(piece)?.[1];
    return key && Object.hasOwn(values, key) ? <Fragment key={index}>{values[key]}</Fragment> : piece;
  });
}

import React, { useState } from 'react';
import { t } from './i18n.mjs';

// A recorded input's picture: the shared small preview first (the first viewer of an image stores it), then the original
// file, then a neutral tile when the file is gone, never a broken image.
function InputPicture({ asset, alt, assetUrl, Icon }) {
  const [step, setStep] = useState(0);
  if (step > 1) return <span className="run-input-missing" role="img" aria-label={t('Image no longer available')}><Icon name="image" size={20}/></span>;
  return <img src={step ? assetUrl(asset) : `${assetUrl(asset)}/thumb`} alt={alt} loading="lazy" decoding="async" onError={() => setStep(step + 1)}/>;
}

// The images a cloud run was given (graph.mjs runInputRecord), under the prompt in an image's details. A board image
// opens its own details while its node is still on the board; a custom node's references are listed under its name.
export function RunInputs({ inputs, canOpen, open, assetUrl, Icon }) {
  const images = inputs.filter(input => !input.template), templates = [...new Set(inputs.filter(input => input.template).map(input => input.template))];
  return <>
    {(images.length > 0 || !templates.length) && <span className="detail-label">{t('Reference images')}</span>}
    {images.length > 0 ? <div className="run-inputs">{images.map((input, index) => {
      const name = input.label || t('Input image {number}', { number: index + 1 });
      // The number its connection showed and the prompt used (“image 2”); older runs did not record one.
      const picture = <><InputPicture asset={input.asset} alt={name} assetUrl={assetUrl} Icon={Icon}/>{input.number && <span className="run-input-number" aria-hidden="true">{input.number}</span>}{input.mask && <span className="run-input-badge">{t('Mask')}</span>}</>;
      return input.nodeId && canOpen(input.nodeId)
        ? <button type="button" className="run-input" key={`${index}:${input.asset}`} aria-label={t('Open {name}', { name })} data-tooltip={name} onClick={() => open(input.nodeId)}>{picture}</button>
        : <span className="run-input" key={`${index}:${input.asset}`} title={name}>{picture}</span>;
    })}</div> : !templates.length && <p>{t('No reference images')}</p>}
    {templates.map(name => <div className="run-template" key={name}>
      <span className="detail-label">{t('Custom node: {name}', { name })}</span>
      <div className="run-inputs">{inputs.filter(input => input.template === name).map((input, index) => <span className="run-input" key={`${index}:${input.asset}`}>
        <InputPicture asset={input.asset} alt={t('{name} reference {number}', { name, number: index + 1 })} assetUrl={assetUrl} Icon={Icon}/></span>)}</div>
    </div>)}
  </>;
}

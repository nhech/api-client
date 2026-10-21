/**
 * A picture from a response. The only place where the page sets an address on an element: the address must be a data address
 * of a picture type that the extension builds from a fixed list, so a response can never make the page load something from the
 * network or from the machine.
 */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|avif);base64,[A-Za-z0-9+/=]+$/;

export function ImageView(props: { source: string }) {
  if (!DATA_IMAGE.test(props.source)) return <p class="hint">This picture cannot be shown.</p>;
  return <div class="image-box"><img src={props.source} alt="The picture in the body of the response" /></div>;
}

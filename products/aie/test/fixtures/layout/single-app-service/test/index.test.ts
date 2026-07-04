import { greeting } from '../src/index';

if (greeting('fixture') !== 'hello fixture') {
  throw new Error('unexpected greeting');
}

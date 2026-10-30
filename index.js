/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {headless} from './src/service';

AppRegistry.registerHeadlessTask('RelayboxFlush', () => headless);

AppRegistry.registerComponent(appName, () => App);

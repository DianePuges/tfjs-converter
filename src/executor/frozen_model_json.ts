/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tfc from '@tensorflow/tfjs-core';

import {tensorflow_json} from '../data/compiled_api_json';
import {NamedTensorsMap, TensorInfo} from '../data/types';
import {OperationMapper} from '../operations/operation_mapper_json';

import {GraphExecutor} from './graph_executor';

export const TFHUB_SEARCH_PARAM = '?tfjs-format=file';
export const DEFAULT_MODEL_NAME = 'model.json';
/**
 * A `tf.FrozenModel` is a directed, acyclic graph of built from
 * SavedModel GraphDef and allows inference exeuction.
 */

export class FrozenModel implements tfc.InferenceModel {
  private executor: GraphExecutor;
  private version = 'n/a';
  private handler: tfc.io.IOHandler;
  // Returns the version information for the tensorflow model GraphDef.
  get modelVersion(): string {
    return this.version;
  }

  get inputNodes(): string[] {
    return this.executor.inputNodes;
  }

  get outputNodes(): string[] {
    return this.executor.outputNodes;
  }

  get inputs(): TensorInfo[] {
    return this.executor.inputs;
  }

  get outputs(): TensorInfo[] {
    return this.executor.outputs;
  }

  get weights(): NamedTensorsMap {
    return this.executor.weightMap;
  }

  /**
   * @param modelUrl url for the model file generated by scripts/convert.py
   * script.
   * @param weightManifestUrl url for the weight file generated by
   * scripts/convert.py script.
   * @param requestOption options for Request, which allows to send credentials
   * and custom headers.
   * @param onProgress Optional, progress callback function, fired periodically
   * before the load is completed.
   */
  constructor(
      private modelUrl: string, private requestOption?: RequestInit,
      private weightPrefix?: string, private onProgress?: Function) {}

  private findIOHandler() {
    const path = this.modelUrl;
    if (this.requestOption || this.weightPrefix) {
      this.handler = tfc.io.browserHTTPRequest(
          path, this.requestOption, this.weightPrefix, null, this.onProgress);
    } else {
      const handlers = tfc.io.getLoadHandlers(path, this.onProgress);
      if (handlers.length === 0) {
        // For backward compatibility: if no load handler can be found,
        // assume it is a relative http path.
        handlers.push(tfc.io.browserHTTPRequest(
            path, this.requestOption, this.weightPrefix, null,
            this.onProgress));
      } else if (handlers.length > 1) {
        throw new Error(
            `Found more than one (${handlers.length}) load handlers for ` +
            `URL '${[path]}'`);
      }
      this.handler = handlers[0];
    }
  }

  /**
   * Loads the model and weight files, construct the in memory weight map and
   * compile the inference graph.
   */
  async load(): Promise<boolean> {
    this.findIOHandler();
    if (this.handler.load == null) {
      throw new Error(
          'Cannot proceed with model loading because the IOHandler provided ' +
          'does not have the `load` method implemented.');
    }
    const artifacts = await this.handler.load();
    const graph = artifacts.modelTopology as tensorflow_json.IGraphDef;

    this.version = `${graph.versions.producer}.${graph.versions.minConsumer}`;
    const weightMap =
        tfc.io.decodeWeights(artifacts.weightData, artifacts.weightSpecs);
    this.executor =
        new GraphExecutor(OperationMapper.Instance.transformGraph(graph));
    this.executor.weightMap = this.convertTensorMapToTensorsMap(weightMap);
    return true;
  }

  /**
   * Execute the inference for the input tensors.
   *
   * @param input The input tensors, when there is single input for the model,
   * inputs param should be a `tf.Tensor`. For models with mutliple inputs,
   * inputs params should be in either `tf.Tensor`[] if the input order is
   * fixed, or otherwise NamedTensorMap format.
   *
   * For model with multiple inputs, we recommend you use NamedTensorMap as the
   * input type, if you use `tf.Tensor`[], the order of the array needs to
   * follow the
   * order of inputNodes array. @see {@link FrozenModel.inputNodes}
   *
   * You can also feed any intermediate nodes using the NamedTensorMap as the
   * input type. For example, given the graph
   *    InputNode => Intermediate => OutputNode,
   * you can execute the subgraph Intermediate => OutputNode by calling
   *    frozenModel.execute('IntermediateNode' : tf.tensor(...));
   *
   * This is useful for models that uses tf.dynamic_rnn, where the intermediate
   * state needs to be fed manually.
   *
   * For batch inference execution, the tensors for each input need to be
   * concatenated together. For example with mobilenet, the required input shape
   * is [1, 244, 244, 3], which represents the [batch, height, width, channel].
   * If we are provide a batched data of 100 images, the input tensor should be
   * in the shape of [100, 244, 244, 3].
   *
   * @param config Prediction configuration for specifying the batch size and
   * output node names. Currently the batch size option is ignored for frozen
   * model.
   *
   * @returns Inference result tensors. The output would be single `tf.Tensor`
   * if model has single output node, otherwise Tensor[] or NamedTensorMap[]
   * will be returned for model with multiple outputs.
   */
  predict(
      inputs: tfc.Tensor|tfc.Tensor[]|tfc.NamedTensorMap,
      config?: tfc.ModelPredictConfig): tfc.Tensor
      |tfc.Tensor[]|tfc.NamedTensorMap {
    return this.execute_(inputs, true, this.outputNodes);
  }

  private constructTensorMap(inputs: tfc.Tensor|tfc.Tensor[]) {
    const inputArray = inputs instanceof tfc.Tensor ? [inputs] : inputs;
    if (inputArray.length !== this.inputNodes.length) {
      throw new Error(
          'Input tensor count mismatch,' +
          `the frozen model has ${this.inputNodes.length} placeholders, ` +
          `while there are ${inputArray.length} input tensors.`);
    }
    return this.inputNodes.reduce((map, inputName, i) => {
      map[inputName] = inputArray[i];
      return map;
    }, {} as tfc.NamedTensorMap);
  }
  /**
   * Executes inference for the model for given input tensors.
   * @param inputs tensor, tensor array or tensor map of the inputs for the
   * model, keyed by the input node names.
   * @param outputs output node name from the Tensorflow model, if no
   * outputs are specified, the default outputs of the model would be used.
   * You can inspect intermediate nodes of the model by adding them to the
   * outputs array.
   *
   * @returns A single tensor if provided with a single output or no outputs
   * are provided and there is only one default output, otherwise return a
   * tensor array. The order of the tensor array is the same as the outputs
   * if provided, otherwise the order of outputNodes attribute of the model.
   */
  execute(
      inputs: tfc.Tensor|tfc.Tensor[]|tfc.NamedTensorMap,
      outputs?: string|string[]): tfc.Tensor|tfc.Tensor[] {
    return this.execute_(inputs, false, outputs);
  }

  private execute_(
      inputs: tfc.Tensor|tfc.Tensor[]|tfc.NamedTensorMap,
      strictInputCheck = true, outputs?: string|string[]): tfc.Tensor
      |tfc.Tensor[] {
    outputs = outputs || this.outputNodes;
    if (inputs instanceof tfc.Tensor || Array.isArray(inputs)) {
      inputs = this.constructTensorMap(inputs);
    }
    if (this.executor.isControlFlowModel || this.executor.isDynamicShapeModel) {
      throw new Error(
          'The model contains control flow or dynamic shape ops, ' +
          'please use executeAsync method');
    }
    const result = this.executor.execute(
        this.convertTensorMapToTensorsMap(inputs), strictInputCheck, outputs);
    const keys = Object.keys(result);
    return (Array.isArray(outputs) && outputs.length > 1) ?
        outputs.map(node => result[node]) :
        result[keys[0]];
  }
  /**
   * Executes inference for the model for given input tensors in async
   * fashion, use this method when your model contains control flow ops.
   * @param inputs tensor, tensor array or tensor map of the inputs for the
   * model, keyed by the input node names.
   * @param outputs output node name from the Tensorflow model, if no outputs
   * are specified, the default outputs of the model would be used. You can
   * inspect intermediate nodes of the model by adding them to the outputs
   * array.
   *
   * @returns A Promise of single tensor if provided with a single output or
   * no outputs are provided and there is only one default output, otherwise
   * return a tensor map.
   */
  async executeAsync(
      inputs: tfc.Tensor|tfc.Tensor[]|tfc.NamedTensorMap,
      outputs?: string|string[]): Promise<tfc.Tensor|tfc.Tensor[]> {
    if (!(this.executor.isControlFlowModel ||
          this.executor.isDynamicShapeModel)) {
      throw new Error(
          'The model does not contain control flow or dynamic shape ops, ' +
          'please use execute method for better performance.');
    }
    outputs = outputs || this.outputNodes;
    if (inputs instanceof tfc.Tensor || Array.isArray(inputs)) {
      inputs = this.constructTensorMap(inputs);
    }

    const result = await this.executor.executeAsync(
        this.convertTensorMapToTensorsMap(inputs), outputs);
    const keys = Object.keys(result);
    return Array.isArray(outputs) && outputs.length > 1 ?
        outputs.map(node => result[node]) :
        result[keys[0]];
  }

  private convertTensorMapToTensorsMap(map: tfc.NamedTensorMap):
      NamedTensorsMap {
    return Object.keys(map).reduce((newMap: NamedTensorsMap, key) => {
      newMap[key] = [map[key]];
      return newMap;
    }, {});
  }
  /**
   * Releases the memory used by the weight tensors.
   */
  dispose() {
    this.executor.dispose();
  }
}

/**
 * Load the frozen model through url.
 *
 * Example of loading the MobileNetV2 model and making a prediction with a zero
 * input.
 *
 * ```js
 * const GOOGLE_CLOUD_STORAGE_DIR =
 *     'https://storage.googleapis.com/tfjs-models/savedmodel/';
 * const MODEL_URL = 'mobilenet_v2_1.0_224/model.json';
 * const model = await tf.loadFrozenModel(GOOGLE_CLOUD_STORAGE_DIR + MODEL_URL);
 * const zeros = tf.zeros([1, 224, 224, 3]);
 * model.predict(zeros).print();
 * ```
 *
 * @param modelUrl url for the model file generated by scripts/convert.py
 * script.
 * @param weightManifestUrl url for the weight file generated by
 * scripts/convert.py script.
 * @param requestOption options for Request, which allows to send credentials
 * and custom headers.
 * @param onProgress Optional, progress callback function, fired periodically
 * before the load is completed.
 */
export async function loadFrozenModel(
    modelUrl: string, requestOption?: RequestInit,
    onProgress?: Function): Promise<FrozenModel> {
  const model = new FrozenModel(modelUrl, requestOption, null, onProgress);
  await model.load();
  return model;
}

/**
 * Load the frozen model hosted by TF-Hub.
 *
 * Example of loading the MobileNetV2 model and making a prediction with a zero
 * input.
 *
 * ```js
 * const TFHUB_MOBILENET =
 *   'https://tfhub.dev/google/imagenet/mobilenet_v2_140_224/classification/2';
 * const model = await tf.loadTfHubModule(TFHUB_MOBILENET);
 * const zeros = tf.zeros([1, 224, 224, 3]);
 * model.predict(zeros).print();
 * ```
 *
 * @param tfhubModelUrl url for the model hosted by TF-Hub, i.e.
 * 'https://tfhub.dev/google/imagenet/mobilenet_v2_140_224/classification/2'.
 * @param requestOption options for Request, which allows to send credentials
 * and custom headers.
 * @param onProgress Optional, progress callback function, fired periodically
 * before the load is completed.
 */
export async function loadTfHubModule(
    tfhubModuleUrl: string, requestOption?: RequestInit,
    onProgress?: Function): Promise<FrozenModel> {
  if (!tfhubModuleUrl.endsWith('/')) {
    tfhubModuleUrl = tfhubModuleUrl + '/';
  }
  return loadFrozenModel(
      `${tfhubModuleUrl}${DEFAULT_MODEL_NAME}${TFHUB_SEARCH_PARAM}`,
      requestOption, onProgress);
}

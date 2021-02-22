import React, { useState, useEffect, useCallback, useRef } from "react";
import shortid from "shortid";
import { Group, Rect, Line } from "react-konva";
import useImage from "use-image";

import diagonalPattern from "../../images/DiagonalPattern.png";

import { useMapInteraction } from "../../contexts/MapInteractionContext";
import { useMapStage } from "../../contexts/MapStageContext";
import { useGrid } from "../../contexts/GridContext";
import { useKeyboard } from "../../contexts/KeyboardContext";

import Vector2 from "../../helpers/Vector2";
import {
  simplifyPoints,
  mergeFogShapes,
  getFogShapesBoundingBoxes,
  getGuidesFromBoundingBoxes,
  getGuidesFromGridCell,
  findBestGuides,
} from "../../helpers/drawing";
import colors from "../../helpers/colors";
import {
  HoleyLine,
  Tick,
  getRelativePointerPosition,
} from "../../helpers/konva";

import SubtractShapeAction from "../../actions/SubtractShapeAction";

import useSetting from "../../hooks/useSetting";

function MapFog({
  map,
  shapes,
  onShapesAdd,
  onShapesCut,
  onShapesRemove,
  onShapesEdit,
  active,
  toolSettings,
  editable,
}) {
  const {
    stageScale,
    mapWidth,
    mapHeight,
    interactionEmitter,
  } = useMapInteraction();
  const {
    grid,
    gridCellNormalizedSize,
    gridCellPixelSize,
    gridStrokeWidth,
    gridCellPixelOffset,
    gridOffset,
  } = useGrid();
  const [gridSnappingSensitivity] = useSetting("map.gridSnappingSensitivity");
  const mapStageRef = useMapStage();

  const [drawingShape, setDrawingShape] = useState(null);
  const [isBrushDown, setIsBrushDown] = useState(false);
  const [editingShapes, setEditingShapes] = useState([]);

  // Shapes that have been merged for fog
  const [fogShapes, setFogShapes] = useState(shapes);
  // Bounding boxes for guides
  const [fogShapeBoundingBoxes, setFogShapeBoundingBoxes] = useState([]);
  const [guides, setGuides] = useState([]);

  const shouldHover =
    active &&
    editable &&
    (toolSettings.type === "toggle" || toolSettings.type === "remove");

  const shouldRenderGuides =
    active &&
    editable &&
    (toolSettings.type === "rectangle" || toolSettings.type === "polygon");

  const [patternImage] = useImage(diagonalPattern);

  useEffect(() => {
    if (!active || !editable) {
      return;
    }

    const mapStage = mapStageRef.current;

    function getBrushPosition(snapping = true) {
      const mapImage = mapStage.findOne("#mapImage");
      let position = getRelativePointerPosition(mapImage);
      if (snapping && shouldRenderGuides) {
        for (let guide of guides) {
          if (guide.orientation === "vertical") {
            position.x = guide.start.x * mapWidth;
          }
          if (guide.orientation === "horizontal") {
            position.y = guide.start.y * mapHeight;
          }
        }
      }
      return Vector2.divide(position, {
        x: mapImage.width(),
        y: mapImage.height(),
      });
    }

    function handleBrushDown() {
      if (toolSettings.type === "brush") {
        const brushPosition = getBrushPosition();
        setDrawingShape({
          type: "fog",
          data: {
            points: [brushPosition],
            holes: [],
          },
          strokeWidth: 0.5,
          color: toolSettings.useFogCut ? "red" : "black",
          id: shortid.generate(),
          visible: true,
        });
      }
      if (toolSettings.type === "rectangle") {
        const brushPosition = getBrushPosition();
        setDrawingShape({
          type: "fog",
          data: {
            points: [
              brushPosition,
              brushPosition,
              brushPosition,
              brushPosition,
            ],
            holes: [],
          },
          strokeWidth: 0.5,
          color: toolSettings.useFogCut ? "red" : "black",
          id: shortid.generate(),
          visible: true,
        });
      }
      setIsBrushDown(true);
    }

    function handleBrushMove() {
      if (toolSettings.type === "brush" && isBrushDown && drawingShape) {
        const brushPosition = getBrushPosition();
        setDrawingShape((prevShape) => {
          const prevPoints = prevShape.data.points;
          if (
            Vector2.compare(
              prevPoints[prevPoints.length - 1],
              brushPosition,
              0.001
            )
          ) {
            return prevShape;
          }
          return {
            ...prevShape,
            data: {
              ...prevShape.data,
              points: [...prevPoints, brushPosition],
            },
          };
        });
      }
      if (toolSettings.type === "rectangle" && isBrushDown && drawingShape) {
        const prevPoints = drawingShape.data.points;
        const brushPosition = getBrushPosition();
        setDrawingShape((prevShape) => {
          return {
            ...prevShape,
            data: {
              ...prevShape.data,
              points: [
                prevPoints[0],
                { x: brushPosition.x, y: prevPoints[1].y },
                brushPosition,
                { x: prevPoints[3].x, y: brushPosition.y },
              ],
            },
          };
        });
      }
    }

    function handleBrushUp() {
      if (
        (toolSettings.type === "brush" || toolSettings.type === "rectangle") &&
        drawingShape
      ) {
        const cut = toolSettings.useFogCut;

        let drawingShapes = [drawingShape];
        if (!toolSettings.multilayer) {
          const shapesToSubtract = shapes.filter((shape) =>
            cut ? !shape.visible : shape.visible
          );
          const subtractAction = new SubtractShapeAction(
            mergeFogShapes(shapesToSubtract, !cut)
          );
          const state = subtractAction.execute({
            [drawingShape.id]: drawingShape,
          });
          drawingShapes = Object.values(state)
            .filter((shape) => shape.data.points.length > 2)
            .map((shape) => ({ ...shape, id: shortid.generate() }));
        }

        if (drawingShapes.length > 0) {
          drawingShapes = drawingShapes.map((shape) => {
            let shapeData = {};
            if (cut) {
              shapeData = { id: shape.id, type: shape.type };
            } else {
              shapeData = { ...shape, color: "black" };
            }
            return {
              ...shapeData,
              data: {
                ...shape.data,
                points: simplifyPoints(
                  shape.data.points,
                  gridCellNormalizedSize,
                  // Downscale fog as smoothing doesn't currently work with edge snapping
                  Math.max(stageScale, 1) / 2
                ),
              },
            };
          });

          if (cut) {
            onShapesCut(drawingShapes);
          } else {
            onShapesAdd(drawingShapes);
          }
        }
        setDrawingShape(null);
      }

      eraseHoveredShapes();

      setIsBrushDown(false);
    }

    function handlePointerClick() {
      if (toolSettings.type === "polygon") {
        const brushPosition = getBrushPosition();
        setDrawingShape((prevDrawingShape) => {
          if (prevDrawingShape) {
            return {
              ...prevDrawingShape,
              data: {
                ...prevDrawingShape.data,
                points: [...prevDrawingShape.data.points, brushPosition],
              },
            };
          } else {
            return {
              type: "fog",
              data: {
                points: [brushPosition, brushPosition],
                holes: [],
              },
              strokeWidth: 0.5,
              color: toolSettings.useFogCut ? "red" : "black",
              id: shortid.generate(),
              visible: true,
            };
          }
        });
      }
    }

    function handlePointerMove() {
      if (
        active &&
        (toolSettings.type === "polygon" || toolSettings.type === "rectangle")
      ) {
        let guides = [];
        const brushPosition = getBrushPosition(false);
        const absoluteBrushPosition = Vector2.multiply(brushPosition, {
          x: mapWidth,
          y: mapHeight,
        });
        if (map.snapToGrid) {
          guides.push(
            ...getGuidesFromGridCell(
              absoluteBrushPosition,
              grid,
              gridCellPixelSize,
              gridOffset,
              gridCellPixelOffset,
              gridSnappingSensitivity,
              { x: mapWidth, y: mapHeight }
            )
          );
        }

        guides.push(
          ...getGuidesFromBoundingBoxes(
            brushPosition,
            fogShapeBoundingBoxes,
            gridCellNormalizedSize,
            gridSnappingSensitivity
          )
        );

        setGuides(findBestGuides(brushPosition, guides));
      }
      if (toolSettings.type === "polygon") {
        const brushPosition = getBrushPosition();
        if (toolSettings.type === "polygon" && drawingShape) {
          setDrawingShape((prevShape) => {
            if (!prevShape) {
              return;
            }
            return {
              ...prevShape,
              data: {
                ...prevShape.data,
                points: [...prevShape.data.points.slice(0, -1), brushPosition],
              },
            };
          });
        }
      }
    }

    function handelTouchEnd() {
      setGuides([]);
    }

    interactionEmitter.on("dragStart", handleBrushDown);
    interactionEmitter.on("drag", handleBrushMove);
    interactionEmitter.on("dragEnd", handleBrushUp);
    // Use mouse events for polygon and erase to allow for single clicks
    mapStage.on("mousedown touchstart", handlePointerMove);
    mapStage.on("mousemove touchmove", handlePointerMove);
    mapStage.on("click tap", handlePointerClick);
    mapStage.on("touchend", handelTouchEnd);

    return () => {
      interactionEmitter.off("dragStart", handleBrushDown);
      interactionEmitter.off("drag", handleBrushMove);
      interactionEmitter.off("dragEnd", handleBrushUp);
      mapStage.off("mousedown touchstart", handlePointerMove);
      mapStage.off("mousemove touchmove", handlePointerMove);
      mapStage.off("click tap", handlePointerClick);
      mapStage.off("touchend", handelTouchEnd);
    };
  });

  const finishDrawingPolygon = useCallback(() => {
    const cut = toolSettings.useFogCut;

    let polygonShape = {
      id: drawingShape.id,
      type: drawingShape.type,
      data: {
        ...drawingShape.data,
        // Remove the last point as it hasn't been placed yet
        points: drawingShape.data.points.slice(0, -1),
      },
    };

    let polygonShapes = [polygonShape];
    if (!toolSettings.multilayer) {
      const shapesToSubtract = shapes.filter((shape) =>
        cut ? !shape.visible : shape.visible
      );
      const subtractAction = new SubtractShapeAction(
        mergeFogShapes(shapesToSubtract, !cut)
      );
      const state = subtractAction.execute({
        [polygonShape.id]: polygonShape,
      });
      polygonShapes = Object.values(state)
        .filter((shape) => shape.data.points.length > 2)
        .map((shape) => ({ ...shape, id: shortid.generate() }));
    }

    if (polygonShapes.length > 0) {
      if (cut) {
        onShapesCut(polygonShapes);
      } else {
        onShapesAdd(
          polygonShapes.map((shape) => ({
            ...drawingShape,
            data: shape.data,
            id: shape.id,
            color: "black",
          }))
        );
      }
    }

    setDrawingShape(null);
  }, [toolSettings, drawingShape, onShapesCut, onShapesAdd, shapes]);

  // Add keyboard shortcuts
  function handleKeyDown({ key }) {
    if (key === "Enter" && toolSettings.type === "polygon" && drawingShape) {
      finishDrawingPolygon();
    }
    if (key === "Escape" && drawingShape) {
      setDrawingShape(null);
    }
    // Remove last point from polygon shape if delete pressed
    if (
      (key === "Backspace" || key === "Delete") &&
      drawingShape &&
      toolSettings.type === "polygon"
    ) {
      if (drawingShape.data.points.length > 2) {
        setDrawingShape((drawingShape) => ({
          ...drawingShape,
          data: {
            ...drawingShape.data,
            points: [
              // Shift last point to previous point
              ...drawingShape.data.points.slice(0, -2),
              ...drawingShape.data.points.slice(-1),
            ],
          },
        }));
      } else {
        setDrawingShape(null);
      }
    }
  }

  useKeyboard(handleKeyDown);

  // Update shape color when useFogCut changes
  useEffect(() => {
    setDrawingShape((prevShape) => {
      if (!prevShape) {
        return;
      }
      return {
        ...prevShape,
        color: toolSettings.useFogCut ? "red" : "black",
      };
    });
  }, [toolSettings.useFogCut]);

  function eraseHoveredShapes() {
    // Erase
    if (editingShapes.length > 0) {
      if (toolSettings.type === "remove") {
        onShapesRemove(editingShapes.map((shape) => shape.id));
      } else if (toolSettings.type === "toggle") {
        onShapesEdit(
          editingShapes.map((shape) => ({
            id: shape.id,
            visible: !shape.visible,
          }))
        );
      }
      setEditingShapes([]);
    }
  }

  function handleShapeOver(shape, isDown) {
    if (shouldHover && isDown) {
      if (editingShapes.findIndex((s) => s.id === shape.id) === -1) {
        setEditingShapes((prevShapes) => [...prevShapes, shape]);
      }
    }
  }

  function reducePoints(acc, point) {
    return [...acc, point.x * mapWidth, point.y * mapHeight];
  }

  function renderShape(shape) {
    const points = shape.data.points.reduce(reducePoints, []);
    const holes =
      shape.data.holes &&
      shape.data.holes.map((hole) => hole.reduce(reducePoints, []));
    return (
      <HoleyLine
        key={shape.id}
        onMouseMove={() => handleShapeOver(shape, isBrushDown)}
        onTouchOver={() => handleShapeOver(shape, isBrushDown)}
        onMouseDown={() => handleShapeOver(shape, true)}
        onTouchStart={() => handleShapeOver(shape, true)}
        onMouseUp={eraseHoveredShapes}
        onTouchEnd={eraseHoveredShapes}
        points={points}
        stroke={
          editable ? colors.lightGray : colors[shape.color] || shape.color
        }
        fill={colors[shape.color] || shape.color}
        closed
        lineCap="round"
        lineJoin="round"
        strokeWidth={gridStrokeWidth * shape.strokeWidth}
        opacity={editable ? (!shape.visible ? 0.2 : 0.5) : 1}
        fillPatternImage={patternImage}
        fillPriority={active && !shape.visible ? "pattern" : "color"}
        holes={holes}
        // Disable collision if the fog is transparent and we're not editing it
        // This allows tokens to be moved under the fog
        hitFunc={editable && !active ? () => {} : undefined}
      />
    );
  }

  function renderEditingShape(shape) {
    const editingShape = {
      ...shape,
      color: "#BB99FF",
    };
    return renderShape(editingShape);
  }

  function renderPolygonAcceptTick(shape) {
    if (shape.data.points.length === 0) {
      return null;
    }
    const isCross = shape.data.points.length < 4;
    return (
      <Tick
        x={shape.data.points[0].x * mapWidth}
        y={shape.data.points[0].y * mapHeight}
        scale={1 / stageScale}
        cross={isCross}
        onClick={(e) => {
          e.cancelBubble = true;
          if (isCross) {
            setDrawingShape(null);
          } else {
            finishDrawingPolygon();
          }
        }}
      />
    );
  }

  function renderGuides() {
    return guides.map((guide, index) => (
      <Line
        points={[
          guide.start.x * mapWidth,
          guide.start.y * mapHeight,
          guide.end.x * mapWidth,
          guide.end.y * mapHeight,
        ]}
        stroke="hsl(260, 100%, 80%)"
        key={index}
        strokeWidth={gridStrokeWidth * 0.25}
        lineCap="round"
        lineJoin="round"
      />
    ));
  }

  useEffect(() => {
    function shapeVisible(shape) {
      return (active && !toolSettings.preview) || shape.visible;
    }

    if (editable) {
      const visibleShapes = shapes.filter(shapeVisible);
      setFogShapeBoundingBoxes(getFogShapesBoundingBoxes(visibleShapes));
      setFogShapes(visibleShapes);
    } else {
      setFogShapes(mergeFogShapes(shapes));
    }
  }, [shapes, editable, active, toolSettings]);

  const fogGroupRef = useRef();

  return (
    <Group>
      <Group ref={fogGroupRef}>
        {/* Render a blank shape so cache works with no fog shapes */}
        <Rect width={1} height={1} />
        {fogShapes.map(renderShape)}
      </Group>
      {shouldRenderGuides && renderGuides()}
      {drawingShape && renderShape(drawingShape)}
      {drawingShape &&
        toolSettings &&
        toolSettings.type === "polygon" &&
        renderPolygonAcceptTick(drawingShape)}
      {editingShapes.length > 0 && editingShapes.map(renderEditingShape)}
    </Group>
  );
}

export default MapFog;
